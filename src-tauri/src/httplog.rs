//! HTTP 请求统一记录层：ureq 3.x Middleware 挂在共享 Agent 上，全仓 HTTP 调用
//! （claim/touch/balance/oauth/token/referral 等全部 zcode 上游接口）自动落
//! flowlog——URL/方法/请求体/状态/耗时/响应体（JSON 全量、非 JSON 截 2K，见
//! resp_for_log），系统日志页可查。
//!
//! ureq 3.x 相比 2.x 的关键差异（本仓迁移决策的依据）：
//! - middleware 收到 http::Request<SendBody>，请求体在链上可读（2.x 的 Request
//!   类型无 body 字段，只能靠调用点手工落行）——req/resp 两行统一在中间件落，
//!   调用点零插桩；
//! - Agent 统一 http_status_as_error(false)：4xx/5xx 返回 Ok(resp)。默认行为
//!   Error::StatusCode 会丢弃响应体，而 body 里的业务 code（401/3004/429 语义）
//!   是各调用点分流的依据，所以状态码一律走 Ok 路径由调用方判断，Err 只剩
//!   网络/协议层错误；
//! - send_json 的载荷是 to_vec_pretty 字节，中间件读出后 JSON round-trip 重建
//!   （SendBody::from_json）字节一致，且重建体自带 Content-Length——不会把
//!   LengthDelimited 请求形态破坏成 chunked（裸 reader 重建会）；
//! - 响应体读出后用 Body::builder().data 重建等价响应回传，调用方拿到的仍是
//!   完整体，无感。

use std::io::Read;
use std::time::Instant;

use ureq::http::{Request, Response};
use ureq::middleware::{Middleware, MiddlewareNext};
use ureq::{Body, SendBody};

use crate::flowlog;

/// 响应体落行策略：JSON 全量（展开视图要看完整结构，不截断）；非 JSON（WAF
/// 拦截页 HTML 等可达数百 KB）截 2K 控日志体量——那类体本无结构可展开
const PLAIN_CAP: usize = 2048;

fn resp_for_log(body: &str) -> &str {
    if serde_json::from_str::<serde_json::Value>(body.trim()).is_ok() {
        body
    } else {
        let n = body.trim().char_indices().nth(PLAIN_CAP).map(|(i, _)| i).unwrap_or(body.trim().len());
        &body.trim()[..n]
    }
}

/// URL 缩短为 host+path（域名重复无信息量；query 保留：seq/platform 等动态参数
/// 是排障证据，现有调用无 token 走 query，不引入脱敏负担）
fn short_url(url: &str) -> String {
    url.split("://").last().unwrap_or(url).to_string()
}

/// flow 记录：按 URL 域名归类——zcode.z.ai/billing、marketing → claim 流；
/// api.z.ai / bigmodel.cn 的 oauth/token 类 → oauth 流；其余 → sys
fn flow_of(url: &str) -> &'static str {
    if url.contains("marketing") || url.contains("billing") || url.contains("client/configs") {
        "claim"
    } else if url.contains("oauth") || url.contains("token") || url.contains("userinfo") {
        "oauth"
    } else {
        "sys"
    }
}

/// Kiro 式结果行：「{method} {path} → status ms resp」——请求标识 + 箭头结果 +
/// 内联响应体（截 2K），一行独立可读；请求体行（http-req）在中间件请求侧落，
/// req 与 resp 永不混行。
fn log_http(method: &str, url: &str, status: u16, body: &str, elapsed_ms: u128, flow: &'static str) {
    let event = if (200..300).contains(&status) { "http-ok" } else { "http-err" };
    // JSON 全量 / 非 JSON 截 2K（策略见 resp_for_log）
    flowlog::log(
        flow,
        event,
        &format!(
            "{method} {} → {status} ms={elapsed_ms} resp={}",
            short_url(url),
            resp_for_log(body)
        ),
    );
}

/// httplog 中间件：请求侧读体落 http-req 行，响应侧读体落 http-ok/http-err 行，
/// 两方向读后均重建等价值回传（JSON 走 round-trip 保 Content-Length，见模块头）。
struct HttpLogMw;

impl Middleware for HttpLogMw {
    fn handle(
        &self,
        request: Request<SendBody>,
        next: MiddlewareNext,
    ) -> Result<Response<Body>, ureq::Error> {
        // —— 请求侧：读出请求体落行（GET/HEAD 的空体不落，避免噪音行）
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let url = parts.uri.to_string();
        let flow = flow_of(&url);
        let mut buf = Vec::new();
        body.into_reader().read_to_end(&mut buf).map_err(ureq::Error::from)?;
        if !buf.is_empty() {
            flowlog::log(
                flow,
                "http-req",
                &format!("{method} {} req={}", short_url(&url), String::from_utf8_lossy(&buf)),
            );
        }
        let send_body = if buf.is_empty() {
            SendBody::none()
        } else {
            match serde_json::from_slice::<serde_json::Value>(&buf) {
                Ok(v) => SendBody::from_json(&v)?,
                // 非 JSON 体（预留）：字节原样回放，形态退化为 chunked 可接受
                Err(_) => SendBody::from_owned_reader(std::io::Cursor::new(buf)),
            }
        };
        let request = Request::from_parts(parts, send_body);

        // —— 响应侧：读体落行，重建等价响应回传
        let t0 = Instant::now();
        match next.handle(request) {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let (rp, mut rb) = resp.into_parts();
                match rb.read_to_string() {
                    Ok(text) => {
                        log_http(&method, &url, status, &text, t0.elapsed().as_millis(), flow);
                        let body = Body::builder().data(text.into_bytes());
                        Ok(Response::from_parts(rp, body))
                    }
                    Err(e) => {
                        // 读失败（>10MB limit / 连接中断）：记错误行，调用方按网络错处理
                        flowlog::log(
                            flow,
                            "http-err",
                            &format!(
                                "{method} {} → {status} ms={} resp read failed: {e}",
                                short_url(&url),
                                t0.elapsed().as_millis()
                            ),
                        );
                        Err(ureq::Error::from(e))
                    }
                }
            }
            Err(e) => {
                // 网络层错误（连接拒绝/DNS 失败/超时）：无响应体可记，记元信息
                log_http(&method, &url, 0, &e.to_string(), t0.elapsed().as_millis(), flow);
                Err(e)
            }
        }
    }
}

/// 带记录的 ureq Agent 工厂（进程级单例，按超时档各一池）：全仓 HTTP 调用统一
/// 从这里建 Agent，中间件自动落 flowlog。claim.rs 的 agent() / oauth.rs 的
/// web_agent() / referral.rs / probe.rs 都调这里。
pub fn logged_agent(timeout_secs: u64) -> ureq::Agent {
    static AGENTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, ureq::Agent>>> =
        std::sync::OnceLock::new();
    let map = AGENTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(timeout_secs)
        .or_insert_with(|| {
            ureq::config::Config::builder()
                .middleware(HttpLogMw)
                // 4xx/5xx 返回 Ok(resp)：默认 Error::StatusCode 会丢响应体，
                // 而 body 里的业务 code 是调用点分流依据（见模块头）
                .http_status_as_error(false)
                .timeout_connect(Some(std::time::Duration::from_secs(10)))
                .timeout_global(Some(std::time::Duration::from_secs(timeout_secs)))
                .build()
                .into()
        })
        .clone()
}

/// 统一读响应：返回 (HTTP 状态码, body 文本)。所有调用点的响应消费都走这里——
/// 3.x 无 into_string()，Body::read_to_string 自带 10MB limit（对齐 2.x）。
/// 4xx/5xx 不在此转错：状态码是调用点自己的分流依据（biz code 语义）。
pub(crate) fn read_resp(resp: Response<Body>) -> Result<(u16, String), ureq::Error> {
    let status = resp.status().as_u16();
    let text = resp.into_body().read_to_string()?;
    Ok((status, text))
}

/// HTTP 4xx/5xx 响应转错误串：msg/message/error 字段提取 + body 截 750 字符附
/// 第二行（前端 toast 收起显示短句，点开展开看全文）。
pub(crate) fn http_resp_err(prefix: &str, status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| ["msg", "message", "error"]
            .iter()
            .find_map(|k| v.get(k).and_then(|x| x.as_str()).map(String::from)))
        .unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        return format!("{prefix} HTTP {status}: {msg}");
    }
    let cut = body.char_indices().nth(750).map(|(i, _)| i).unwrap_or(body.len());
    let clipped = &body[..cut];
    format!("{prefix} HTTP {status}: {msg}\n{clipped}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use ureq::middleware::MiddlewareNext;

    /// 本地假服务：循环读满 Content-Length 后回固定 JSON，返回原始请求文本
    fn spawn_fake_server() -> (std::net::SocketAddr, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw);
                let want = text
                    .to_lowercase()
                    .split("content-length:")
                    .nth(1)
                    .and_then(|r| r.split("\r\n").next())
                    .and_then(|v| v.trim().parse::<usize>().ok());
                let Some(want) = want else { continue };
                let body_start = match text.find("\r\n\r\n") {
                    Some(i) => i + 4,
                    None => continue,
                };
                if raw.len() - body_start >= want {
                    break;
                }
            }
            let req = String::from_utf8_lossy(&raw).to_string();
            let resp = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\n\r\n{\"code\":0,\"ok\":1}";
            s.write_all(resp.as_bytes()).unwrap();
            req
        });
        (addr, h)
    }

    fn body_of(raw: &str) -> &str {
        match raw.find("\r\n\r\n") {
            Some(i) => &raw[i + 4..],
            None => "",
        }
    }

    /// 基线：middleware 全程不碰 body 直接放行，服务端必须收到载荷
    #[test]
    fn baseline_passthrough_sends_body() {
        let (addr, server) = spawn_fake_server();
        let agent: ureq::Agent = ureq::config::Config::builder()
            .middleware(|req: Request<SendBody>, next: MiddlewareNext| next.handle(req))
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build()
            .into();
        let resp = agent
            .post(format!("http://{addr}/t"))
            .send_json(serde_json::json!({ "a": 1 }))
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let raw = server.join().unwrap();
        assert_eq!(body_of(&raw), "{\n  \"a\": 1\n}", "baseline body lost:\n{raw}");
    }

    /// 隔离点：middleware 读走 body 后用 SendBody::from_json 重建（当前实现）
    #[test]
    fn reread_from_json_rebuild_sends_body() {
        let (addr, server) = spawn_fake_server();
        let agent: ureq::Agent = ureq::config::Config::builder()
            .middleware(|req: Request<SendBody>, next: MiddlewareNext| {
                let (parts, body) = req.into_parts();
                let mut buf = Vec::new();
                body.into_reader().read_to_end(&mut buf).map_err(ureq::Error::from)?;
                let send = if buf.is_empty() {
                    SendBody::none()
                } else {
                    SendBody::from_json(&serde_json::from_slice::<serde_json::Value>(&buf).unwrap())?
                };
                next.handle(Request::from_parts(parts, send))
            })
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build()
            .into();
        let resp = agent
            .post(format!("http://{addr}/t"))
            .send_json(serde_json::json!({ "a": 1 }))
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let raw = server.join().unwrap();
        assert_eq!(body_of(&raw), "{\n  \"a\": 1\n}", "rebuild body lost:\n{raw}");
    }

    /// 端到端全链路（HttpLogMw + flowlog + logged_agent）：① middleware 读到
    /// 请求体落 http-req 行（2.x 类型层面做不到）② 重建后 Content-Length 形态
    /// 保住、载荷字节完整 ③ 响应体经中间件重建后调用方读回 ④ req/resp 两行落盘
    #[test]
    fn middleware_logs_req_and_resp_body() {
        // flowlog 落到独立临时目录，不污染真实日志
        let dir = std::env::temp_dir().join(format!("zhub-httplog-test-{}", uuid::Uuid::new_v4()));
        flowlog::init(&dir);

        let (addr, server) = spawn_fake_server();
        let agent = logged_agent(5);
        let resp = agent
            .post(format!("http://{addr}/test"))
            .send_json(serde_json::json!({ "a": 1 }))
            .unwrap();
        let (status, body) = read_resp(resp).unwrap();
        assert_eq!(status, 200);
        assert!(body.contains("\"code\":0"), "resp body: {body}");

        let raw_req = server.join().unwrap();
        let lower = raw_req.to_lowercase();
        assert!(lower.contains("content-length:"), "missing content-length:\n{raw_req}");
        assert!(!lower.contains("transfer-encoding"), "degraded to chunked:\n{raw_req}");
        // send_json 走 to_vec_pretty，载荷是 pretty 形态
        assert_eq!(body_of(&raw_req), "{\n  \"a\": 1\n}", "json payload lost:\n{raw_req}");

        let log = std::fs::read_to_string(dir.join("logs").join("oauth.log")).unwrap();
        let sys_flow = log.lines().filter(|l| l.contains("[sys]")).collect::<Vec<_>>().join("\n");
        assert!(sys_flow.contains("http-req") && sys_flow.contains("req="), "http-req line missing:\n{sys_flow}");
        assert!(sys_flow.contains("http-ok") && sys_flow.contains("resp="), "http-ok line missing:\n{sys_flow}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
