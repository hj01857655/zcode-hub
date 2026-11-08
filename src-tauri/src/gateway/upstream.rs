// GATEWAY 上游客户端：z.ai anthropic messages 端点调用（SSE 响应透传）
// 一律 stream=true、错误分类冷却。头集策略见 headers()：默认薄头（M3-E 实测形态）。
use reqwest::Client as HttpClient;

/// 上游 messages 端点（协议文档 docs/CLAIM.md / GATEWAY.md §2）
pub const UPSTREAM_MESSAGES: &str =
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

pub struct UpstreamError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "upstream {}: {}", self.status, self.body)
    }
}

/// messages 头集（2026-11-01 版本门限定案）：WAF 对「版本自述」按版本号分档——
/// 3.17.1（最新）触发严格 bot 检查（UA 与 X-ZCode-App-Version 均单条实锤 3012，
/// scripts/header_bisect.py + version_family_bisect.py）；≤3.16.3 放行（3.14.0 两条、
/// 全头族 3.16.3 均实测 200）。故整套官方头族回归、版本钉死 3.16.3——与 body 主线
/// 前缀同版本代际。版本号可用 ZCODE_GATEWAY_APP_VERSION 覆盖做归因实验；
/// touch 投放通道仍走 quota.rs 的注册表真实探测（那边 3.17.x 才能拿投放）；
/// billing/claim 与 marketing/touch/action 自 2026-11-03 起也改随探测值（投放按版本过滤，
/// 领取必须与看到投放的同一档，否则 1004），**不再**钉本档。
// 与 claim 通道同源（quota.rs），改档一处生效
const SAFE_APP_VERSION: &str = crate::quota::SAFE_APP_VERSION;

/// 自动降级档：SAFE 自述撞风控后锁存到此（3.14.0 单头实测 200；全头族组合未单独验过，
/// 但降级只在 SAFE 已被拒时发生，劣化风险为零）。
const FALLBACK_APP_VERSION: &str = "3.14.0";

static VERSION_DOWNGRADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 生效版本：环境变量手动钉 > 自动降级锁存 > 默认 SAFE
pub fn effective_app_version() -> String {
    if let Ok(v) = std::env::var("ZCODE_GATEWAY_APP_VERSION") {
        if !v.is_empty() {
            return v;
        }
    }
    if VERSION_DOWNGRADED.load(std::sync::atomic::Ordering::SeqCst) {
        FALLBACK_APP_VERSION.into()
    } else {
        SAFE_APP_VERSION.into()
    }
}

/// 降级闩：SAFE 版本自述撞 405/3012 时锁存切到 FALLBACK，下一发请求生效（失败那发
/// 不重试，is_global_risk 的全局退避照旧）。不自动回升——解除降级由人工改代码或重启进程。
pub fn note_risk_response(status: u16, body: &str) {
    if !is_global_risk(status, body) {
        return;
    }
    if std::env::var("ZCODE_GATEWAY_APP_VERSION").map(|v| !v.is_empty()).unwrap_or(false) {
        return; // 手动钉版本做归因实验时不介入，保持实验环境可控
    }
    if !VERSION_DOWNGRADED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        // body 摘要随行：触发源是 status==405 还是 body 3012，降级行上直接可判
        //（429+3012 组合形态出现时只有 body 能区分）。闩一生只落一次，无噪音负担
        let body_hint: String = body.trim().chars().take(200).collect();
        crate::flowlog::log("gateway", "version-downgraded", &format!("{SAFE_APP_VERSION} 撞风控（{status}）→ {FALLBACK_APP_VERSION} body={body_hint}"));
        eprintln!("[gateway] 版本自述 {SAFE_APP_VERSION} 撞风控（{status}），锁存降级到 {FALLBACK_APP_VERSION}");
    }
}

pub fn headers(token: &str, mid: Option<&str>) -> Vec<(String, String)> {
    let ver = effective_app_version();
    let mut h: Vec<(String, String)> = vec![
        ("User-Agent".into(), format!("ZCode/{ver}")),
        ("HTTP-Referer".into(), "https://zcode.z.ai".into()),
        ("X-Title".into(), "Z Code@electron".into()),
        ("X-ZCode-App-Version".into(), ver.clone()),
        ("X-Platform".into(), crate::quota::client_platform()),
        ("X-Release-Channel".into(), "stable".into()),
        ("X-Os-Category".into(), std::env::consts::OS.into()),
        ("X-Client-Language".into(), "zh-CN".into()),
        ("X-Client-Timezone".into(), crate::quota::client_timezone()),
        ("anthropic-version".into(), "2023-06-01".into()),
        ("Authorization".into(), format!("Bearer {token}")),
        ("x-request-id".into(), uuid::Uuid::new_v4().to_string()),
        ("Content-Type".into(), "application/json".into()),
    ];
    if let Some(v) = crate::quota::os_version() {
        h.push(("X-Os-Version".into(), v));
    }
    if let Some(m) = mid {
        h.push(("X-Device-Mid".into(), m.to_string()));
    }
    h
}

/// 发送 anthropic body（上游一律 stream=true）。返回原始响应：M2 非流式由调用侧
/// bytes().await 聚合，M3/M4 直接逐块转发 SSE。
pub async fn messages_stream(
    http: &HttpClient,
    token: &str,
    mid: Option<&str>,
    body: &[u8],
) -> Result<reqwest::Response, UpstreamError> {
    let mut req = http.post(UPSTREAM_MESSAGES);
    for (k, v) in headers(token, mid) {
        req = req.header(k, v);
    }
    let resp = req
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| UpstreamError { status: 0, body: e.to_string() })?;
    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(4096)
            .collect();
        return Err(UpstreamError { status, body });
    }
    // HTTP 200 但 body 是 JSON 错误体（非 SSE）：上游的计费/风控闸偶尔用 200 包业务错误
    //（11-04 实锤：1005 "exceed quota limit" 以 200+JSON 形态返回）。content-type 与
    // 首字节判定——JSON 错误体转 UpstreamError（带 HTTP 200 + 原始 body），让 pool_send
    // 走既有错误路径（冷却/换号/错误透传），而不是被当 SSE 流透传 + 截断检测误合成 overloaded_error。
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if ct.contains("json") {
        let body = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(4096)
            .collect();
        return Err(UpstreamError { status, body });
    }
    Ok(resp)
}

/// body 业务码提取：JSON 解析取 code 字段（顶层优先，其次 error 内层），字符串
/// 数字也接受；非 JSON/无 code 返回 None。**不用 contains 匹配数字码**——logid
/// 等数字串会误命中子串（实锤 11-08：3008 并发限流的 logid `…03012724…` 含
/// "3012" 子串，被误判全局风控触发版本降级）。
fn body_code(body: &str) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    fn find(v: &serde_json::Value) -> Option<i64> {
        match v {
            serde_json::Value::Object(m) => m
                .get("code")
                .and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(|s| s.parse().ok())))
                .or_else(|| m.values().find_map(find)),
            _ => None,
        }
    }
    find(&v)
}

/// 冷却时长（秒）：0 = 不冷却不换号。5xx 短冷 30s：上游瞬断不值得长罚，但不能不罚
/// （否则故障上游会被重放循环反复选中）。
pub fn cooldown_secs(status: u16, body: &str) -> u64 {
    let code = body_code(body);
    match status {
        401 => 30 * 60,            // token 失效
        429 => 60,                 // 限流/额度
        405 => 10 * 60,            // 风控
        _ if code == Some(3012) => 10 * 60, // 风控
        _ if code == Some(3007) => 60, // 安全验证：body code（HTTP 400），确定性拒绝，不冷却会拿固定 JWT 无限重打
        _ if matches!(code, Some(3008 | 3009 | 3010)) => 60,
        _ if code == Some(1005) => 10 * 60, // exceed quota limit（HTTP 200 包业务错误，11-04 实锤）：额度耗尽确定性拒绝，短冷却会无限重打
        _ if (500..600).contains(&status) => 30,
        _ => 0,
    }
}

/// 3012/405 是 IP+指纹级风控：不只冷却单号，整个农场全局退避并立即放弃本次请求
pub fn is_global_risk(status: u16, body: &str) -> bool {
    status == 405 || body_code(body) == Some(3012)
}

/// 该错误是否值得换号重放一轮（业务性/瞬时错误）。5xx 视为上游瞬断：换号重放
pub fn is_retryable(status: u16, body: &str) -> bool {
    status == 0 // 网络错误
        || status == 429
        || (500..600).contains(&status)
        || matches!(body_code(body), Some(3008 | 3009 | 3010))
}

/// user 级并发上限（3008）：预期内容量拒绝，账号本身健康——收尾走 settle_transient
/// 不进熔断窗口，避免 chronic 3008 放大成全池 10min 长冷却雪崩
pub fn is_user_concurrency_limit(body: &str) -> bool {
    body_code(body) == Some(3008)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_and_retry_tiers() {
        // 分档：token 失效长罚、限流短罚、5xx 瞬断 30s、未知业务错误不罚
        assert_eq!(cooldown_secs(401, ""), 30 * 60);
        assert_eq!(cooldown_secs(429, ""), 60);
        assert_eq!(cooldown_secs(502, "bad gateway"), 30);
        assert_eq!(cooldown_secs(400, "ordinary error"), 0);
        // 风控档与全局退避判定（body 走 JSON code 字段精确提取）
        assert_eq!(cooldown_secs(400, r#"{"code":3012,"msg":"risk"}"#), 10 * 60);
        assert_eq!(cooldown_secs(400, r#"{"error":{"code":3012}}"#), 10 * 60);
        assert_eq!(cooldown_secs(400, r#"{"code":3007}"#), 60);
        assert_eq!(cooldown_secs(200, r#"{"code":1005,"msg":"exceed quota limit"}"#), 10 * 60);
        assert!(is_global_risk(405, ""));
        assert!(is_global_risk(200, r#"{"code":3012}"#));
        assert!(!is_global_risk(502, ""));
        // 重放判定：5xx/429/网络/并发档换号，确定性拒绝（3007/401）不重放
        assert!(is_retryable(0, ""));
        assert!(is_retryable(429, ""));
        assert!(is_retryable(500, ""));
        assert!(is_retryable(400, r#"{"code":3008}"#));
        assert!(!is_retryable(400, r#"{"code":3007}"#));
        assert!(!is_retryable(401, ""));
    }

    /// 回归（11-08 实锤）：3008 并发限流的 logid 时间戳含 "3012" 子串，contains
    /// 粗匹配曾误判全局风控 → 版本降级闩误触发。code 字段精确提取后不得命中。
    #[test]
    fn logid_substring_must_not_trigger_risk() {
        let body = r#"{"code":3008,"msg":"user concurrency limit exceeded","logid":"2026110803012724a1e2abbaf1a20f6b92"}"#;
        assert!(!is_global_risk(429, body));
        assert!(is_retryable(429, body));
        assert_eq!(cooldown_secs(429, body), 60);
    }
}
