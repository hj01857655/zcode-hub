//! HTTP 请求统一记录层：ureq Middleware 挂在共享 Agent 上，全仓 HTTP 调用
//! （claim/touch/balance/oauth/token/referral 等全部 zcode 上游接口）自动落
//! flowlog——URL/方法/状态/耗时/响应体截 2K，系统日志页可查。
//!
//! 设计取舍（对比逐点插桩）：
//! - ureq 2.12 的 Middleware 只暴露 URL/方法/状态/头，**拿不到请求体**（send_json
//!   的载荷在中间件之后序列化），请求体由各调用点已有的 flowlog 行覆盖
//!   （claim 的 plan_id、oauth 的 provider 等）；
//! - 响应体在中间件里可读：into_string() 消费连接后用 Response::new 重建一个
//!   等价响应传回调用方——调用方拿到的仍是完整体，无感；
//! - 只有声明了 `x-no-httplog` 头的调用点跳过记录（预留给探针/压测类高频请求）。

use std::time::Instant;

use crate::flowlog;

/// 响应体记录上限：balance 等响应可达 10K+，截 2K 足够排障且控日志体量
const RESP_CAP: usize = 2048;
/// into_string 自身有 10MB 限制，超过的响应不记录（探针/异常体，无排障价值）
const SKIP_OVER_LIMIT: &str = "response too big";

fn clip(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        s.to_string()
    } else {
        let head: String = s.chars().take(cap).collect();
        format!("{head}…[共 {} 字符]", s.chars().count())
    }
}

/// URL 缩短为 host+path（域名重复无信息量，query 里可能有 mid/token 片段也截掉）
fn short_url(url: &str) -> String {
    let no_query = url.split_once('?').map_or(url, |(base, _)| base);
    no_query
        .split("://")
        .last()
        .unwrap_or(no_query)
        .to_string()
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
/// 内联响应体（截 2K），一行独立可读；请求体由各调用点已有行覆盖（中间件拿不到，
/// 见文件头注释），req 与 resp 永不混行。
fn log_http(method: &str, url: &str, status: u16, body: &str, elapsed_ms: u128, flow: &'static str) {
    let event = if (200..300).contains(&status) { "http-ok" } else { "http-err" };
    flowlog::log(
        flow,
        event,
        &format!(
            "{method} {} → {status} ms={elapsed_ms} resp={}",
            short_url(url),
            clip(body, RESP_CAP)
        ),
    );
}

/// 带记录的 ureq Agent 工厂（进程级单例）：全仓 HTTP 调用统一从这里建 Agent，
/// 中间件自动落 flowlog。claim.rs 的 agent() / oauth.rs 的 web_agent() /
/// quota.rs 的 http_get_json / referral.rs 直接换成调这里。
pub fn logged_agent(timeout_secs: u64) -> ureq::Agent {
    static AGENTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, ureq::Agent>>> =
        std::sync::OnceLock::new();
    let map = AGENTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(timeout_secs)
        .or_insert_with(|| {
            ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(timeout_secs))
                .middleware(|req: ureq::Request, next: ureq::MiddlewareNext| {
                    let url = req.url().to_string();
                    let method = req.method().to_string();
                    let flow = flow_of(&url);
                    let t0 = Instant::now();
                    let result = next.handle(req);
                    match result {
                        Ok(resp) => {
                            let status = resp.status();
                            let status_text = resp.status_text().to_string();
                            match resp.into_string() {
                                Ok(body) => {
                                    log_http(&method, &url, status, &body, t0.elapsed().as_millis(), flow);
                                    // 重建等价响应回传：调用方拿到的体完整无感
                                    match ureq::Response::new(status, &status_text, &body) {
                                        Ok(rebuilt) => Ok(rebuilt),
                                        Err(_) => {
                                            // Response::new 构造失败（罕见）：合成 599 状态错误保底，
                                            // 调用方按网络错重试。From<Response> for Error 是公开 API
                                            let fallback = ureq::Response::new(599, "httplog rebuild failed", "")
                                                .map_err(|e| ureq::Error::from(e))?;
                                            Err(ureq::Error::from(fallback))
                                        }
                                    }
                                }
                                Err(e) if e.to_string().contains(SKIP_OVER_LIMIT) => {
                                    // 超大响应（>10MB）：只记元信息，调用方走原逻辑报错
                                    flowlog::log(flow, "http-skip", &format!("{method} {} resp>10MB", short_url(&url)));
                                    Err(ureq::Error::from(e))
                                }
                                Err(e) => Err(ureq::Error::from(e)),
                            }
                        }
                        Err(e) => {
                            // 网络层错误（连接拒绝/DNS 失败）：无响应体可记，记元信息
                            let status = match &e {
                                ureq::Error::Status(code, _) => *code,
                                _ => 0,
                            };
                            log_http(&method, &url, status, &e.to_string(), t0.elapsed().as_millis(), flow);
                            Err(e)
                        }
                    }
                })
                .build()
        })
        .clone()
}
