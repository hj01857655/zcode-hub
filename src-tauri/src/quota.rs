
use crate::zcrypto;
use serde_json::Value;
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

#[cfg(windows)]
fn no_window(prog: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(prog);
    c.creation_flags(0x0800_0000);
    c
}
#[cfg(not(windows))]
fn no_window(prog: &str) -> std::process::Command {
    std::process::Command::new(prog)
}

pub const QUOTA_LIMIT_URL: &str = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
pub const SUBSCRIPTION_URL: &str = "https://open.bigmodel.cn/api/biz/subscription/list";
pub const BILLING_BALANCE_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
pub const CLIENT_APP_VERSION: &str = "3.17.2";

/// 领取通道版本：曾固定 3.14.0（生态流传防 3012），2026-10-31 实测推翻——
/// 3.17.1 的头+URL 直打 billing/claim 连续 12 次成功零 3012，版本不敏感。
/// billing 全链与 touch 统一走探测版本（zcode_app_version），不再保留专用常量。
/// 探测兜底随 2026-11-02 客户端 3.17.2 更新同步。

pub(crate) fn client_platform() -> String {
    let os = crate::zcrypto::node_platform_for(std::env::consts::OS);
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

pub const BUILTIN_CODING_PLAN_MODELS: &[&str] = &["GLM-5.3", "GLM-5.3-Flash"];
pub const BUILTIN_START_PLAN_MODELS: &[&str] = &["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"];

pub(crate) fn canonical_model_id(id: &str) -> String {
    let lower = id.to_lowercase();
    for m in BUILTIN_CODING_PLAN_MODELS
        .iter()
        .chain(BUILTIN_START_PLAN_MODELS.iter())
    {
        if m.to_lowercase() == lower {
            return m.to_string();
        }
    }
    id.to_string()
}

const ZCODE_ORIGIN: &str = "https://zcode.z.ai";
pub(crate) const ZCODE_LANG: &str = "zh-CN";
const ZCODE_CHANNEL: &str = "stable";

pub(crate) fn device_mid() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let home = crate::store::pick_home(
                crate::store::env_dir("ZCODE_HUB_HOME", "ZCODE_SWITCH_HOME"),
                std::env::var("USERPROFILE").ok().map(std::path::PathBuf::from),
                std::env::var("HOME").ok().map(std::path::PathBuf::from),
            );
            let p = crate::store::resolve_data_root(&home)
                .join(".zcode")
                .join("v2")
                .join("telemetry-state.json");
            std::fs::read_to_string(p)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.get("deviceMid").and_then(|m| m.as_str()).map(String::from))
        })
        .clone()
}

#[cfg(windows)]
pub(crate) fn os_version() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let out = no_window("reg")
                .args(["query", r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "/v", "CurrentBuildNumber"])
                .output()
                .ok()?;
            let txt = String::from_utf8_lossy(&out.stdout);
            let build = txt.lines().find(|l| l.contains("CurrentBuildNumber"))?
                .rsplit(' ').find(|t| !t.is_empty())?.to_string();
            Some(format!("10.0.{build}"))
        })
        .clone()
}

#[cfg(not(windows))]
pub(crate) fn os_version() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let out = no_window("uname").arg("-r").output().ok()?;
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!v.is_empty()).then_some(v)
        })
        .clone()
}

#[cfg(windows)]
pub(crate) fn client_timezone() -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let out = no_window("tzutil").arg("/g").output().ok();
            let name = out
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            match name.as_str() {
                "China Standard Time" | "China Daylight Time" => "Asia/Shanghai",
                "Singapore Standard Time" => "Asia/Singapore",
                "Tokyo Standard Time" => "Asia/Tokyo",
                "UTC" => "UTC",
                _ => "unknown",
            }
            .to_string()
        })
        .clone()
}

#[cfg(not(windows))]
pub(crate) fn client_timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "unknown".to_string())
}

/// 读取通道自述版本（额度/touch/OAuth/探测）：注册表探测本机实际安装的 ZCode 版本。
/// 2026-11-03 订正：投放端点按 app_version 过滤，探测版 3.17.2 下同批 14 号有 9 号看到
/// `zcode-v3-start-plan-1103`，钉 3.16.3 全部返回空 deliveries（scripts/touch_live.py 对照实锤）。
/// 写端点（claim/messages）另走 `SAFE_APP_VERSION`，见 `zai_claim_headers_with_mid`。
pub(crate) fn zcode_app_version() -> String {
    registry_probe_app_version()
}

fn registry_probe_app_version() -> String {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            for hive in [
                r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
                r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            ] {
                let Ok(out) = no_window("reg").args(["query", hive, "/s"]).output() else {
                    continue;
                };
                let txt = String::from_utf8_lossy(&out.stdout);
                let (mut name, mut ver) = (String::new(), String::new());
                for line in txt.lines() {
                    let l = line.trim();
                    if l.starts_with("HKEY_") {
                        if is_zcode_display_name(&name) && !ver.is_empty() {
                            return normalize_version(&ver);
                        }
                        name.clear();
                        ver.clear();
                        continue;
                    }
                    if let Some(rest) = l.strip_prefix("DisplayName") {
                        name = rest.trim_start().trim_start_matches("REG_SZ").trim().to_string();
                    } else if let Some(rest) = l.strip_prefix("DisplayVersion") {
                        ver = rest.trim_start().trim_start_matches("REG_SZ").trim().to_string();
                    }
                }
                if is_zcode_display_name(&name) && !ver.is_empty() {
                    return normalize_version(&ver);
                }
            }
            CLIENT_APP_VERSION.to_string()
        })
        .clone()
}

fn is_zcode_display_name(name: &str) -> bool {
    let l = name.to_lowercase();
    l.contains("zcode") && !l.contains("switch")
}

fn normalize_version(v: &str) -> String {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() >= 3 {
        format!("{}.{}.{}", parts[0], parts[1], parts[2])
    } else {
        v.to_string()
    }
}

pub(crate) fn zai_billing_headers(token: &str) -> Vec<(String, String)> {
    zai_billing_headers_with_mid(token, device_mid())
}

pub(crate) fn zai_billing_headers_with_mid(token: &str, mid: Option<String>) -> Vec<(String, String)> {
    zai_headers_with_version(zcode_app_version(), token, mid)
}
/// 领取与投放动作（billing/claim、marketing/touch/action）版本头策略（2026-11-03 订正）：
/// 跟投放读取通道同版本（`zcode_app_version()` 探测值）——投放按 app_version 过滤，
/// 领取必须用同一个自述版本，否则服务端视为「该档客户端无此投放」直接 1004。
/// 10-31 已有 A/B 实锤：3.17.1 头连续 12 号全部 200，3.14.0 头一律 1004；11-02 的
/// 「动作端点一律降档」是预防性口径（当时无对照数据），已被 11-03 现象推翻。
/// gateway messages 仍单独钉 `SAFE_APP_VERSION`（WAF 对 3.17.x 自述的动作类对话判 3012/405，
/// 与领取资格闸是两个不同的闸），撞风控自动降级见 `gateway::upstream::note_risk_response`。
pub(crate) fn zai_claim_headers_with_mid(token: &str, mid: Option<String>) -> Vec<(String, String)> {
    zai_headers_with_version(zcode_app_version(), token, mid)
}

/// 仅 gateway messages 通道取用（领取链已改随探测值，见 `zai_claim_headers_with_mid`）；
/// 撞风控自动降到 3.14.0（`gateway::upstream::FALLBACK_APP_VERSION`）。
pub(crate) const SAFE_APP_VERSION: &str = "3.16.3";

pub(crate) struct OAuthFlowHeaders(pub Vec<(String, String)>);

pub(crate) fn zai_oauth_headers_with_mid(token: &str, mid: Option<String>) -> OAuthFlowHeaders {
    OAuthFlowHeaders(zai_headers_with_version(zcode_app_version(), token, mid))
}

fn zai_headers_with_version(ver: String, token: &str, mid: Option<String>) -> Vec<(String, String)> {
    let mut h: Vec<(String, String)> = vec![
        ("User-Agent".into(), format!("ZCode/{ver}")),
        ("HTTP-Referer".into(), ZCODE_ORIGIN.into()),
        ("X-Title".into(), "Z Code@electron".into()),
        ("X-ZCode-App-Version".into(), ver.clone()),
        ("X-Platform".into(), client_platform()),
        ("X-Release-Channel".into(), ZCODE_CHANNEL.into()),
        ("X-Client-Language".into(), ZCODE_LANG.into()),
        ("X-Client-Timezone".into(), client_timezone()),
        ("X-Os-Category".into(), std::env::consts::OS.into()),
    ];
    if let Some(v) = os_version() {
        h.push(("X-Os-Version".into(), v));
    }
    if let Some(mid) = mid {
        h.push(("X-Device-Mid".into(), mid));
    }
    h.push(("Authorization".into(), format!("Bearer {token}")));
    h.push(("x-request-id".into(), uuid::Uuid::new_v4().to_string()));
    h
}

fn bigmodel_headers(token: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("User-Agent".into(), format!("ZCode/{}", zcode_app_version())),
        ("x-request-id".into(), uuid::Uuid::new_v4().to_string()),
    ]
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct QuotaItem {
    pub name: String,
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub percent_used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_percentage: Option<f64>,
    pub unit: String,
    pub period_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct PlanSlot {
    #[serde(skip_serializing)]
    pub pid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expire: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starts: Option<String>,
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub percent_used: Option<f64>,
    pub items: Vec<QuotaItem>,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub struct QuotaOverview {
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub percent_used: Option<f64>,
    pub plan_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_expire: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_starts: Option<String>,
    pub is_empty: bool,
    pub items: Vec<QuotaItem>,
    pub refreshed_at: i64,
    pub source: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plans: Vec<PlanSlot>,
}

fn safe_decrypt(value: Option<&str>, secret: &str) -> Option<String> {
    let v = value?;
    if zcrypto::is_encrypted(v) {
        zcrypto::decrypt_with_secret(v, secret).ok()
    } else {
        Some(v.to_string())
    }
}

fn looks_like_token(v: &str) -> bool {
    v.trim().len() > 20
}

fn coding_plan_api_keys(config: Option<&Value>) -> Vec<String> {
    let mut keys = vec![];
    let providers = match config.and_then(|c| c.get("provider")).and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return keys,
    };
    let mut ordered: Vec<(&String, &Value)> = providers.iter().collect();
    ordered.sort_by_key(|(_, p)| if p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false) { 0 } else { 1 });
    for (id, p) in ordered {
        if !id.contains("coding-plan") {
            continue;
        }
        if let Some(k) = p.get("options").and_then(|o| o.get("apiKey")).and_then(|k| k.as_str()) {
            if !k.starts_with("enc:") && looks_like_token(k) && !keys.contains(&k.to_string()) {
                keys.push(k.to_string());
            }
        }
    }
    keys
}

fn coding_plan_keys_from_creds(creds: &Value, secret: &str) -> Vec<String> {
    let Some(map) = creds.as_object() else { return vec![] };
    let mut out: Vec<String> = vec![];
    for (k, v) in map {
        if !k.starts_with("account-provider:") || !k.ends_with(":api-key") { continue; }
        if !k.contains("coding-plan") { continue; }
        let Some(p) = v.as_str().and_then(|v| safe_decrypt(Some(v), secret)) else { continue };
        if looks_like_token(&p) && !out.contains(&p) { out.push(p); }
    }
    out
}

pub fn candidate_tokens(creds: &Value, config: Option<&Value>, secret: &str, new_gen: bool) -> Vec<String> {
    let mut tokens: Vec<String> = vec![];
    let add = |plain: Option<String>, tokens: &mut Vec<String>| {
        if let Some(p) = plain {
            if looks_like_token(&p) && !tokens.contains(&p) {
                tokens.push(p);
            }
        }
    };
    let creds_keys = coding_plan_keys_from_creds(creds, secret);
    if new_gen {
        for k in &creds_keys {
            add(Some(k.clone()), &mut tokens);
        }
    }
    for k in coding_plan_api_keys(config) {
        tokens.push(k);
    }
    let active = safe_decrypt(
        creds.get("oauth:active_provider").and_then(|v| v.as_str()),
        secret,
    )
    .unwrap_or_else(|| "zai".into());
    let map = creds.as_object();
    add(
        map.and_then(|m| m.get("zcodejwttoken")).and_then(|v| v.as_str()).and_then(|v| safe_decrypt(Some(v), secret)),
        &mut tokens,
    );
    for key in [
        format!("oauth:{active}:access_token"),
        "oauth:bigmodel:access_token".to_string(),
        "oauth:zai:access_token".to_string(),
    ] {
        add(
            map.and_then(|m| m.get(&key)).and_then(|v| v.as_str()).and_then(|v| safe_decrypt(Some(v), secret)),
            &mut tokens,
        );
    }
    if !new_gen {
        for k in creds_keys {
            add(Some(k), &mut tokens);
        }
    }
    tokens
}

/// 凭据冷却表：HTTP 401/403 或业务 401 的凭据记 15 分钟冷却，期间 http_get_json
/// 直接 Err 不发请求——过期令牌不再参与每轮额度轮询（对齐 claim 侧 touch 429
/// 退避的思路）。指纹用凭据哈希不落明文；冷却到期自动移除，换号重登自然生效。
const CRED_COOLDOWN: Duration = Duration::from_secs(15 * 60);

fn cred_fingerprint(token: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn mark_cred_cooldown(token: &str) {
    let fp = cred_fingerprint(token);
    let tail = fp[12..].to_string();
    let mut m = cred_cooldown_map().lock().unwrap_or_else(|e| e.into_inner());
    m.insert(fp, Instant::now() + CRED_COOLDOWN);
    crate::flowlog::log("sys", "http-err",
        &format!("cred-cooldown cred=…{tail} 停止请求 {} 分钟（401/403）", CRED_COOLDOWN.as_secs() / 60));
}

fn cred_cooled(token: &str) -> bool {
    let fp = cred_fingerprint(token);
    let now = Instant::now();
    let mut m = cred_cooldown_map().lock().unwrap_or_else(|e| e.into_inner());
    match m.get(&fp) {
        Some(deadline) if *deadline > now => true,
        _ => {
            m.remove(&fp);
            false
        }
    }
}

fn cred_cooldown_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, Instant>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Instant>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn http_get_json(url: &str, token: &str, retry_429: bool, mid: Option<&str>) -> Result<Value, String> {
    // 冷却命中直接 Err：不发请求，上抛到 UI 显示「已冷却」，额度轮询对过期凭据静默跳过
    if cred_cooled(token) {
        return Err(crate::i18n::tr("err.quota.cred_cooldown"));
    }
    let retry_delays = [500u64, 1500, 4000];
    // quota 读取链自建裸 Agent（不挂 httplog middleware）：每响应只落本函数的
    // 诊断行一行（http-ok-biz/http-err），避免与 middleware 行同响应双行刷屏；
    // 连接池独立对低频轮询无影响。http_status_as_error(false)
    // 与 httplog Agent 同语义：4xx/5xx 走 Ok(resp) 的 body 分流，Err 只剩网络层
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    let agent = AGENT.get_or_init(|| {
        ureq::config::Config::builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .into()
    });
    let headers = if url.contains("zcode.z.ai") {
        zai_billing_headers_with_mid(token, mid.map(str::to_string))
    } else {
        bigmodel_headers(token)
    };
    let req_hdrs = crate::httplog::headers_for_log_pairs(&headers);
    let mut last_err: Option<String> = None;
    let mut backoff: std::slice::Iter<'_, u64> = if retry_429 { retry_delays.iter() } else { [].iter() };
    loop {
        let mut req = agent.get(url);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        let t0 = std::time::Instant::now();
        let resp = req.call().map_err(|e| crate::i18n::trf("err.network", &[("e", &e.to_string())]))?;
        let (status, text) = crate::httplog::read_resp(resp)
            .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
        if (400..600).contains(&status) {
            // HTTP 层 4xx/5xx：诊断行 + 业务 401（body code）→ 冷却、429 → 退避重试、
            // 401/403 → 冷却，其余按响应 msg 报错。JSONL 诊断行走结构化 API，
            // 与 httplog middleware 行同 schema（body 截断策略同 body_for_log）
            crate::flowlog::log_http_with_headers(
                "sys",
                "http-err",
                "GET",
                url,
                Some(status),
                Some(t0.elapsed().as_millis().min(u64::MAX as u128) as u64),
                Some(crate::httplog::body_for_log(&text)),
                Some(&req_hdrs),
                None,
            );
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if v.get("code").and_then(|c| c.as_i64()) == Some(401) {
                    mark_cred_cooldown(token);
                    return Err(crate::i18n::tr("err.token.biz401"));
                }
            }
            if status == 429 {
                match backoff.next() {
                    Some(d) => {
                        last_err = Some(crate::i18n::tr("err.quota.rate_limited"));
                        sleep(Duration::from_millis(*d));
                        continue;
                    }
                    None => return Err(last_err.unwrap_or_else(|| crate::i18n::tr("err.quota.http429"))),
                }
            }
            if status == 401 || status == 403 {
                mark_cred_cooldown(token);
                return Err(crate::i18n::trf("err.token.http401", &[("code", &status.to_string())]));
            }
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| ["message", "msg", "error"].iter().find_map(|k| v.get(k).and_then(|x| x.as_str()).map(String::from)));
            return Err(crate::i18n::trf("err.quota.http", &[("code", &status.to_string()), ("msg", &msg.unwrap_or_default())]));
        }
        // 频度治理：业务码正常的成功响应静默（balance/subscription 周期轮询
        // 每号每轮 2-3 行常态成功行会淹掉错误行）；业务码异常（风控/限流/
        // no_plan 之外的业务错）才落 http-ok-biz 行保留诊断证据
        let biz_code = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("code").and_then(|c| c.as_i64()))
            .unwrap_or(0);
        // bigmodel 风格的业务 401 走 HTTP 200 包装（令牌过期）——同样进冷却，
        // 否则每轮额度刷新都白打一发
        if biz_code == 401 {
            mark_cred_cooldown(token);
        }
        if !business_ok(&serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)) || biz_code != 0 {
            crate::flowlog::log_http_with_headers(
                "sys",
                "http-ok-biz",
                "GET",
                url,
                Some(status),
                Some(t0.elapsed().as_millis().min(u64::MAX as u128) as u64),
                Some(crate::httplog::body_for_log(&text)),
                Some(&req_hdrs),
                None,
            );
        }
        return Ok(if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text.clone()))
        });
    }
}

type FetchFn<'a> = dyn Fn(&str, &str) -> Result<Value, String> + 'a;

/// monitor 用量响应的业务错误归一：401 → token 失效，其余带码带 msg。
fn monitor_biz_err(resp: &Value) -> String {
    match resp.get("code").and_then(|c| c.as_i64()) {
        Some(401) => crate::i18n::tr("err.token.biz401"),
        Some(c) => {
            let msg = ["msg", "message", "error"]
                .iter()
                .find_map(|k| resp.get(k).and_then(|x| x.as_str()).map(String::from))
                .unwrap_or_default();
            crate::i18n::trf("err.quota.biz", &[("code", &c.to_string()), ("msg", &msg)])
        }
        None => crate::i18n::tr("err.quota.bad_resp"),
    }
}

fn query_with_token_via(token: &str, fetch: &FetchFn) -> Result<QuotaOverview, String> {
    // billing/balance 先行（zcode 自家接口，token 在即必达）：与 query_channels_via
    // 的 ZaiBilling 腿同语义——桶空即「无可用套餐」直接定论；bigmodel quota/limit
    // 只在 balance 失败时兜底。无 coding plan 的号不再每轮白挨一发注定失败的
    // monitor 探针（ 曾是首选，401/「不存在coding plan」长期刷屏）
    let url = format!("{BILLING_BALANCE_URL}?app_version={}", zcode_app_version());
    let mut best_err: Option<String> = match fetch(&url, token) {
        Ok(balance) if business_ok(&balance) => {
            let mut ov = normalize_balance(&balance);
            ov.refreshed_at = chrono::Local::now().timestamp_millis();
            ov.source = "zcode.z.ai/billing".into();
            return Ok(if ov.plan_tier.is_some() || !ov.plans.is_empty() {
                ov
            } else {
                no_plan_overview()
            });
        }
        Ok(resp) => {
            let msg = ["msg", "message", "error"]
                .iter()
                .find_map(|k| resp.get(k).and_then(|x| x.as_str()).map(String::from))
                .unwrap_or_default();
            let code = resp.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            Some(crate::i18n::trf("err.quota.biz", &[("code", &code.to_string()), ("msg", &msg)]))
        }
        Err(e) => Some(e),
    };

    // bigmodel 兜底腿·订阅先行（2026-11-08）：subscription/list 定门——有在期 coding
    // 套餐才打 monitor 用量；订阅空 = bigmodel 通道无套餐，直接定论；订阅业务 401 =
    // 同 token 同 host，monitor 必然同样结局（401「令牌已过期」刷屏治理）。仅订阅
    // 网络失败或非鉴权业务失败时保留 monitor 直打兜底（旧行为）。
    match fetch(SUBSCRIPTION_URL, token) {
        Ok(sub) if business_ok(&sub) => {
            let has_sub = sub
                .get("data")
                .and_then(|d| d.as_array())
                .is_some_and(|arr| arr.iter().any(is_active_coding_plan_entry));
            if !has_sub {
                return Ok(no_plan_overview());
            }
            match fetch(QUOTA_LIMIT_URL, token) {
                Ok(limit_resp) if business_ok(&limit_resp) => {
                    let mut ov = normalize_quota_limit(&limit_resp, Some(&sub));
                    ov.refreshed_at = chrono::Local::now().timestamp_millis();
                    ov.source = "bigmodel.cn/api/monitor".into();
                    return Ok(ov);
                }
                Ok(limit_resp) => best_err = Some(monitor_biz_err(&limit_resp)),
                Err(e) => {
                    if best_err.is_none() {
                        best_err = Some(e);
                    }
                }
            }
        }
        Ok(sub)
            if classify_biz_err(sub.get("code").and_then(|c| c.as_i64()).unwrap_or(0))
                == BizErrFamily::Auth =>
        {
            best_err = Some(crate::i18n::tr("err.token.biz401"));
        }
        _ => match fetch(QUOTA_LIMIT_URL, token) {
            Ok(limit_resp) if business_ok(&limit_resp) => {
                let sub = fetch(SUBSCRIPTION_URL, token).ok();
                let mut ov = normalize_quota_limit(&limit_resp, sub.as_ref());
                ov.refreshed_at = chrono::Local::now().timestamp_millis();
                ov.source = "bigmodel.cn/api/monitor".into();
                return Ok(ov);
            }
            Ok(limit_resp) => best_err = Some(monitor_biz_err(&limit_resp)),
            Err(e) => {
                if best_err.is_none() {
                    best_err = Some(e);
                }
            }
        },
    }

    Err(best_err.unwrap_or_else(|| crate::i18n::tr("err.quota.fail")))
}

fn query_with_token(token: &str, mid: Option<&str>) -> Result<QuotaOverview, String> {
    query_with_token_via(token, &|url, tok| http_get_json(url, tok, true, mid))
}
pub(crate) fn business_ok(v: &Value) -> bool {
    let code = v.get("code").and_then(|c| c.as_i64());
    let success = v.get("success").and_then(|s| s.as_bool());
    (code.is_none() || code == Some(200) || code == Some(0)) && success != Some(false)
}

pub(crate) fn is_active_coding_plan_entry(s: &Value) -> bool {
    let coding_name = ["productId", "productName"].iter().any(|k| {
        s.get(k)
            .and_then(|v| v.as_str())
            .map(|v| v.to_lowercase().contains("coding"))
            .unwrap_or(false)
    });
    if !coding_name {
        return false;
    }
    s.get("inCurrentPeriod").and_then(|v| v.as_bool()) == Some(true)
        && s.get("status").and_then(|v| v.as_str()) == Some("VALID")
}

/// 原始 billing/balance 抓取（不做归一化）：领取待生效判定用。
/// normalize_balance 会把 entitlements 兑底成桶条目，「桶未下发」窗口被抹平；
/// 待生效判定要看的正是原始响应里 plans 与 balances 的覆盖关系。
pub(crate) fn fetch_balance_raw(token: &str, mid: Option<&str>) -> Result<Value, String> {
    let url = format!("{BILLING_BALANCE_URL}?app_version={}", zcode_app_version());
    http_get_json(&url, token, false, mid)
}

pub fn query_quota(tokens: &[String], mid: Option<&str>) -> Result<QuotaOverview, String> {
    if tokens.is_empty() {
        return Err(crate::i18n::tr("err.quota.no_token"));
    }
    let mut last_err: Option<String> = None;
    let mut first_business: Option<String> = None;
    let mut auth_fail = 0usize;
    for t in tokens {
        match query_with_token(t, mid) {
            Ok(ov) => return Ok(ov),
            Err(e) => {
                if e.contains("401") {
                    auth_fail += 1;
                } else if first_business.is_none() {
                    first_business = Some(e.clone());
                }
                last_err = Some(e);
            }
        }
    }
    if auth_fail > 0 && auth_fail == tokens.len() {
        sleep(Duration::from_millis(1500));
        if let Ok(ov) = query_with_token(&tokens[0], mid) {
            return Ok(ov);
        }
        return Err(crate::i18n::tr("err.token.expired"));
    }
    Err(first_business.or(last_err).unwrap_or_else(|| crate::i18n::tr("err.quota.fail")))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Channel {
    Monitor(String),
    ZaiBilling(String),
}

pub(crate) fn is_no_plan_message(msg: &str) -> bool {
    msg.contains("不存在coding plan") || msg.contains("没有资格")
}

pub(crate) fn zai_billing_token(creds: &Value, config: Option<&Value>, secret: &str) -> Option<String> {
    let jwt = safe_decrypt(creds.get("zcodejwttoken").and_then(|v| v.as_str()), secret);
    let active = safe_decrypt(
        creds.get("oauth:active_provider").and_then(|v| v.as_str()),
        secret,
    );
    let use_jwt = if active.as_deref() != Some("bigmodel") {
        jwt.is_some()
    } else {
        false
    };
    if use_jwt {
        return jwt;
    }
    let providers = config?.get("provider")?.as_object()?;
    let mut ordered: Vec<(&String, &Value)> = providers.iter().collect();
    ordered.sort_by_key(|(_, p)| if p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false) { 0 } else { 1 });
    for (id, p) in ordered {
        if id.contains("start-plan") {
            if let Some(k) = p.get("options").and_then(|o| o.get("apiKey")).and_then(|k| k.as_str()) {
                if !k.starts_with("enc:") && looks_like_token(k) {
                    return Some(k.to_string());
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum BizErrFamily { Auth, QuotaExhausted, RateLimited, SecurityReject, Param, Server, Unknown }

pub(crate) fn classify_biz_err(code: i64) -> BizErrFamily {
    use BizErrFamily::*;
    match code {
        401 | 1006 => Auth,
        1005 => QuotaExhausted,
        3002 | 3008 | 3009 | 3010 => RateLimited,
        3007 => SecurityReject,
        3001 | 3006 | 3102 => Param,
        2007 => Server,
        _ => Unknown,
    }
}

pub(crate) fn pick_channels(creds: &Value, config: Option<&Value>, secret: &str, new_gen: bool) -> Vec<Channel> {
    let mut chans: Vec<Channel> = vec![];
    if new_gen {
        for k in coding_plan_keys_from_creds(creds, secret) {
            if !chans.contains(&Channel::Monitor(k.clone())) {
                chans.push(Channel::Monitor(k));
            }
        }
        if let Some(t) = zai_billing_token(creds, config, secret) {
            if !chans.contains(&Channel::ZaiBilling(t.clone())) {
                chans.push(Channel::ZaiBilling(t));
            }
        }
    }
    let providers = match config.and_then(|c| c.get("provider")).and_then(|p| p.as_object()) {
        Some(p) => p,
        None => return chans,
    };
    let mut ordered: Vec<(&String, &Value)> = providers.iter().collect();
    ordered.sort_by_key(|(_, p)| if p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false) { 0 } else { 1 });
    let provider_key = |p: &Value| -> Option<String> {
        let k = p.get("options").and_then(|o| o.get("apiKey")).and_then(|k| k.as_str())?;
        (!k.starts_with("enc:") && looks_like_token(k)).then(|| k.to_string())
    };
    for (id, p) in ordered {
        let key = provider_key(p);
        if id.contains("start-plan") {
            let jwt = safe_decrypt(
                creds.get("zcodejwttoken").and_then(|v| v.as_str()),
                secret,
            );
            let active = safe_decrypt(
                creds.get("oauth:active_provider").and_then(|v| v.as_str()),
                secret,
            );
            // start-plan 槽 apiKey 只是登录时的 JWT 快照（重登录只回写 creds，config
            // 快照会过期）。取票对齐 zai_billing_token：active 非 bigmodel 时 creds
            // 新鲜 zcodejwttoken 优先，快照仅兜底——原条件方向反了（== bigmodel），
            // active=zai 的号拿过期快照打 balance → 401（2026-11-08 农场号池实测）。
            let use_jwt = if id.starts_with("builtin:zai") {
                jwt.is_some()
            } else {
                jwt.is_some() && active.as_deref() != Some("bigmodel")
            };
            let tok = if use_jwt { jwt } else { None }.or(key);
            if let Some(t) = tok {
                if !chans.contains(&Channel::ZaiBilling(t.clone())) {
                    chans.push(Channel::ZaiBilling(t));
                }
            }
        } else if id.contains("coding-plan") {
            if let Some(k) = key {
                if !chans.contains(&Channel::Monitor(k.clone())) {
                    chans.push(Channel::Monitor(k));
                }
            }
        }
    }
    if !new_gen {
        for k in coding_plan_keys_from_creds(creds, secret) {
            if !chans.contains(&Channel::Monitor(k.clone())) {
                chans.push(Channel::Monitor(k));
            }
        }
    }
    chans
}

fn no_plan_overview() -> QuotaOverview {
    QuotaOverview {
        plan_tier: None,
        is_empty: true,
        source: "no_plan".into(),
        ..Default::default()
    }
}

fn query_channels_via(channels: &[Channel], fetch: &FetchFn) -> Result<QuotaOverview, String> {
    let mut best_err: Option<String> = None;
    let mut saw_no_plan = false;
    let mut parts: Vec<QuotaOverview> = vec![];
    for ch in channels {
        match ch {
            Channel::Monitor(key) => {
                // 订阅先行（与切换探针 classify_via 同语义，2026-11-08）：有在期 coding
                // 套餐才打 monitor 用量；订阅空 = 无套餐定论；订阅业务 401 = 鉴权失败，
                // monitor 不再白打；订阅网络失败才保留 monitor 直打兜底（旧行为）。
                match fetch(SUBSCRIPTION_URL, key) {
                    Ok(sub) if business_ok(&sub) => {
                        let has_sub = sub
                            .get("data")
                            .and_then(|d| d.as_array())
                            .is_some_and(|arr| arr.iter().any(is_active_coding_plan_entry));
                        if has_sub {
                            match fetch(QUOTA_LIMIT_URL, key) {
                                Ok(resp) if business_ok(&resp) => {
                                    let mut ov = normalize_quota_limit(&resp, Some(&sub));
                                    ov.refreshed_at = chrono::Local::now().timestamp_millis();
                                    ov.source = "bigmodel.cn/api/monitor".into();
                                    parts.push(ov);
                                }
                                Ok(resp) => {
                                    let msg = ["msg", "message", "error"]
                                        .iter()
                                        .find_map(|k| resp.get(k).and_then(|x| x.as_str()).map(String::from))
                                        .unwrap_or_default();
                                    if is_no_plan_message(&msg) {
                                        saw_no_plan = true;
                                    } else if best_err.is_none() {
                                        best_err = Some(monitor_biz_err(&resp));
                                    }
                                }
                                Err(e) => {
                                    if best_err.is_none() {
                                        best_err = Some(e);
                                    }
                                }
                            }
                        } else {
                            saw_no_plan = true;
                        }
                    }
                    Ok(sub)
                        if classify_biz_err(sub.get("code").and_then(|c| c.as_i64()).unwrap_or(0))
                            == BizErrFamily::Auth =>
                    {
                        if best_err.is_none() {
                            best_err = Some(crate::i18n::tr("err.token.biz401"));
                        }
                    }
                    _ => match fetch(QUOTA_LIMIT_URL, key) {
                        Ok(resp) => {
                            if business_ok(&resp) {
                                let sub = fetch(SUBSCRIPTION_URL, key).ok();
                                let mut ov = normalize_quota_limit(&resp, sub.as_ref());
                                ov.refreshed_at = chrono::Local::now().timestamp_millis();
                                ov.source = "bigmodel.cn/api/monitor".into();
                                parts.push(ov);
                            } else {
                                let msg = ["msg", "message", "error"]
                                    .iter()
                                    .find_map(|k| resp.get(k).and_then(|x| x.as_str()).map(String::from))
                                    .unwrap_or_default();
                                if is_no_plan_message(&msg) {
                                    saw_no_plan = true;
                                } else if best_err.is_none() {
                                    best_err = Some(monitor_biz_err(&resp));
                                }
                            }
                        }
                        Err(e) => {
                            if best_err.is_none() {
                                best_err = Some(e);
                            }
                        }
                    },
                }
            }
            Channel::ZaiBilling(tok) => {
                let url = format!("{BILLING_BALANCE_URL}?app_version={}", zcode_app_version());
                match fetch(&url, tok) {
                    Ok(balance) if business_ok(&balance) => {
                        let mut ov = normalize_balance(&balance);
                        ov.refreshed_at = chrono::Local::now().timestamp_millis();
                        ov.source = "zcode.z.ai/billing".into();
                        let has_plan = ov.plan_tier.is_some() || !ov.plans.is_empty();
                        if has_plan {
                            parts.push(ov);
                        } else {
                            saw_no_plan = true;
                        }
                    }
                    Ok(resp) => {
                        if best_err.is_none() {
                            let msg = ["msg", "message", "error"]
                                .iter()
                                .find_map(|k| resp.get(k).and_then(|x| x.as_str()).map(String::from))
                                .unwrap_or_default();
                            let code = resp.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                            best_err = Some(crate::i18n::trf("err.quota.biz", &[("code", &code.to_string()), ("msg", &msg)]));
                        }
                    }
                    Err(e) => {
                        if best_err.is_none() {
                            best_err = Some(e);
                        }
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        if saw_no_plan {
            return Ok(no_plan_overview());
        }
        return Err(best_err.unwrap_or_else(|| crate::i18n::tr("err.quota.fail")));
    }
    Ok(merge_parts(parts))
}

fn merge_parts(parts: Vec<QuotaOverview>) -> QuotaOverview {
    let mut slots: Vec<PlanSlot> = vec![];
    let mut slot_src: Vec<String> = vec![];
    let mut sources: Vec<&str> = vec![];
    let mut refreshed = 0i64;
    for p in &parts {
        if !sources.contains(&p.source.as_str()) {
            sources.push(&p.source);
        }
        refreshed = refreshed.max(p.refreshed_at);
        for s in &p.plans {
            let dup = slot_src.iter().enumerate().any(|(i, src)| {
                src != &p.source
                    && slots[i].tier == s.tier
                    && slots[i].name == s.name
                    && !slots[i].items.is_empty()
                    && !s.items.is_empty()
            });
            if !dup {
                slots.push(s.clone());
                slot_src.push(p.source.clone());
            }
        }
    }
    let items: Vec<QuotaItem> = slots.iter().flat_map(|s| s.items.iter().cloned()).collect();
    let content = |s: &PlanSlot| s.tier.is_some() || !s.items.is_empty() || s.total.is_some();
    let mut pri_idx: Option<usize> = None;
    for (i, s) in slots.iter().enumerate() {
        if !content(s) {
            continue;
        }
        pri_idx = match pri_idx {
            None => Some(i),
            Some(p) if tier_rank(s.tier_code.as_deref()) > tier_rank(slots[p].tier_code.as_deref()) => Some(i),
            _ => pri_idx,
        };
    }
    let (total, used, remaining, percent_used) = match pri_idx.map(|i| &slots[i]) {
        Some(p) => (p.total, p.used, p.remaining, p.percent_used),
        None => (None, None, None, None),
    };
    QuotaOverview {
        total,
        used,
        remaining,
        percent_used,
        plan_tier: pri_idx.map(|i| slots[i].tier.clone()).flatten(),
        plan_expire: pri_idx.map(|i| slots[i].expire.clone()).flatten(),
        plan_starts: pri_idx.and_then(|i| slots[i].starts.clone()),
        is_empty: slots.is_empty(),
        items,
        refreshed_at: refreshed,
        source: sources.join(" + "),
        plans: slots,
    }
}

fn query_channels(channels: &[Channel], mid: Option<&str>) -> Result<QuotaOverview, String> {
    query_channels_via(channels, &|url, tok| http_get_json(url, tok, true, mid))
}

pub fn quota_for_live(home: &Path, creds: &Value, config: Option<&Value>, mid: Option<&str>) -> Result<QuotaOverview, String> {
    let secret = zcrypto::default_secret(home);
    let new_gen = crate::store::new_gen_provider_config(home);
    let channels = pick_channels(creds, config, &secret, new_gen);
    if !channels.is_empty() {
        if let Ok(ov) = query_channels(&channels, mid) {
            return Ok(ov);
        }
    }
    let tokens = candidate_tokens(creds, config, &secret, new_gen);
    query_quota(&tokens, mid)
}

pub fn quota_for_snapshot(home: &Path, creds: &Value, config: Option<&Value>, mid: Option<&str>) -> Result<QuotaOverview, String> {
    quota_for_live(home, creds, config, mid)
}

fn unit_label(unit: Option<i64>, number: Option<i64>) -> (String, String) {
    match unit {
        Some(3) => {
            let n = number.unwrap_or(5);
            (format!("每 {n} 小时"), format!("hours:{n}"))
        }
        Some(4) => ("每天".into(), "daily".into()),
        Some(5) => ("每月".into(), "monthly".into()),
        Some(6) => ("每周".into(), "weekly".into()),
        _ => ("每周期".into(), "cycle".into()),
    }
}

fn fmt_reset_time(ms: Option<i64>) -> Option<String> {
    let ms = ms?;
    if ms <= 0 {
        return None;
    }
    use chrono::TimeZone;
    Some(chrono::Local.timestamp_millis_opt(ms).single()?.format("%m-%d %H:%M").to_string())
}

fn safe_prefix(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut end = n;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn safe_suffix(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut start = s.len() - n;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

fn looks_like_date(d: &str) -> bool {
    d.len() == 10 && d.as_bytes().get(4) == Some(&b'-') && d.as_bytes().get(7) == Some(&b'-')
}

fn looks_like_dt(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 16 {
        return false;
    }
    let p = &b[..16];
    p[4] == b'-' && p[7] == b'-' && p[10] == b' ' && p[13] == b':'
        && (0..16).all(|i| match i {
            0..=3 | 5..=6 | 8..=9 | 11..=12 | 14..=15 => p[i].is_ascii_digit(),
            _ => true,
        })
}

fn extract_expire(obj: &Value) -> Option<String> {
    const KEYS: [&str; 13] = [
        "nextRenewTime", "expireTime", "expire_time", "endTime", "end_time", "expireAt", "expiredTime", "validEndTime",
        "expires_at", "expiresAt", "expired_at", "period_end", "ends_at",
    ];
    for k in KEYS {
        let Some(v) = obj.get(k) else { continue };
        if let Some(n) = v.as_i64() {
            use chrono::TimeZone;
            if n > 1_000_000_000_000 {
                return chrono::Local.timestamp_millis_opt(n).single().map(|t| t.format("%Y-%m-%d %H:%M").to_string());
            }
            if n > 1_000_000_000 {
                return chrono::Local.timestamp_opt(n, 0).single().map(|t| t.format("%Y-%m-%d %H:%M").to_string());
            }
        }
        if let Some(s) = v.as_str() {
            let t = s.trim();
            if t.is_empty() {
                continue;
            }
            if let Ok(n) = t.parse::<i64>() {
                use chrono::TimeZone;
                if n > 1_000_000_000_000 {
                    if let Some(dt) = chrono::Local.timestamp_millis_opt(n).single() {
                        return Some(dt.format("%Y-%m-%d %H:%M").to_string());
                    }
                } else if n > 1_000_000_000 {
                    if let Some(dt) = chrono::Local.timestamp_opt(n, 0).single() {
                        return Some(dt.format("%Y-%m-%d %H:%M").to_string());
                    }
                }
            }
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t) {
                return Some(dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string());
            }
            let t = if t.as_bytes().get(10) == Some(&b'T') {
                format!("{} {}", &t[..10], &t[11..])
            } else {
                t.to_string()
            };
            let d = safe_prefix(&t, 10);
            if looks_like_date(d) {
                if looks_like_dt(&t) {
                    return Some(safe_prefix(&t, 16).to_string());
                }
                return Some(d.to_string());
            }
            return Some(t.to_string());
        }
    }
    if let Some(s) = obj.get("valid").and_then(|v| v.as_str()) {
        let tail = safe_suffix(s, 19);
        if looks_like_dt(tail) {
            return Some(safe_prefix(tail, 16).to_string());
        }
        if looks_like_date(safe_prefix(tail, 10)) {
            return Some(safe_prefix(tail, 10).to_string());
        }
        let d = safe_prefix(s, 10);
        if looks_like_date(d) {
            return Some(d.to_string());
        }
    }
    None
}

/// 计划起始时间（starts_at 等）。effective_at:0 之类的占位值按无起始处理。
fn extract_start(obj: &Value) -> Option<String> {
    const KEYS: [&str; 6] = ["starts_at", "startsAt", "start_time", "startTime", "begins_at", "effective_at"];
    use chrono::TimeZone;
    for k in KEYS {
        let Some(v) = obj.get(k) else { continue };
        let n = v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()));
        if let Some(n) = n {
            if n <= 1_000_000_000 {
                continue;
            }
            let dt = if n > 1_000_000_000_000 {
                chrono::Local.timestamp_millis_opt(n).single()
            } else {
                chrono::Local.timestamp_opt(n, 0).single()
            };
            if let Some(t) = dt {
                return Some(t.format("%Y-%m-%d %H:%M").to_string());
            }
            continue;
        }
        if let Some(s) = v.as_str() {
            let t = s.trim();
            if t.is_empty() {
                continue;
            }
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t) {
                return Some(dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string());
            }
            let d = safe_prefix(t, 10);
            if looks_like_date(d) {
                return if looks_like_dt(t) {
                    Some(safe_prefix(t, 16).to_string())
                } else {
                    Some(d.to_string())
                };
            }
        }
    }
    None
}

fn expiry_field(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Value::Number(_) => {
            let mut o = serde_json::Map::new();
            o.insert("expires_at".to_string(), v.clone());
            extract_expire(&Value::Object(o))
        }
        _ => None,
    }
}

fn tier_from_level(level: &str) -> String {
    let l = level.to_lowercase();
    if l.contains("max") {
        "Max".into()
    } else if l.contains("pro") {
        "Pro".into()
    } else if l.contains("lite") {
        "Lite".into()
    } else {
        level.to_string()
    }
}

fn normalize_quota_limit(limit_resp: &Value, sub_resp: Option<&Value>) -> QuotaOverview {
    let data = limit_resp.get("data").cloned().unwrap_or(Value::Null);
    let limits = data.get("limits").and_then(|l| l.as_array()).cloned().unwrap_or_default();

    let mut items = vec![];
    let mut main: Option<QuotaItem> = None;
    for l in &limits {
        let typ = l.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let unit = l.get("unit").and_then(|u| u.as_i64());
        let number = l.get("number").and_then(|n| n.as_i64());
        let total = l.get("usage").and_then(|v| v.as_f64());
        let used = l.get("currentValue").and_then(|v| v.as_f64());
        let remaining = l.get("remaining").and_then(|v| v.as_f64());
        let percentage = l.get("percentage").and_then(|v| v.as_f64());
        let reset_ms = l.get("nextResetTime").and_then(|v| v.as_i64());
        let (period, window) = unit_label(unit, number);
        let (kind, name, unit_str, unit_code) = match typ {
            "TOKENS_LIMIT" => ("prompt_count", format!("提示次数（{period}）"), "次".to_string(), "count"),
            "TIME_LIMIT" => ("duration", format!("使用时长（{period}）"), "分钟".to_string(), "minutes"),
            _ => ("raw", format!("{typ}（{period}）"), String::new(), ""),
        };
        let percent_used = if let (Some(t), Some(u)) = (total, used) {
            if t > 0.0 { Some((u / t * 100.0).clamp(0.0, 100.0)) } else { None }
        } else {
            percentage.map(|p| p.clamp(0.0, 100.0))
        };
        let reset = fmt_reset_time(reset_ms);
        let item = QuotaItem {
            name,
            total,
            used,
            remaining,
            percent_used,
            server_percentage: percentage,
            unit: unit_str,
            period_end: reset.as_ref().map(|r| format!("{r} 重置")),
            kind: (kind != "").then(|| kind.to_string()),
            window: Some(window),
            unit_code: (unit_code != "").then(|| unit_code.to_string()),
            reset,
        };
        if typ == "TIME_LIMIT" && total.is_some() {
            main = main.or(Some(item.clone()));
        }
        items.push(item);
    }

    let level = data.get("level").and_then(|l| l.as_str()).map(String::from);
    let mut plan_tier = level.as_deref().map(tier_from_level);
    let mut plan_expire: Option<String> = None;
    let mut plan_start: Option<String> = None;
    let mut product_name: Option<String> = None;
    if let Some(sub) = sub_resp {
        if business_ok(sub) {
            if std::env::var("ZSW_DUMP_SUB").is_ok() {
                eprintln!("[zsw] subscription/list raw: {sub}");
            }
            if let Some(arr) = sub.get("data").and_then(|d| d.as_array()) {
                let current = arr
                    .iter()
                    .find(|s| is_active_coding_plan_entry(s))
                    .or_else(|| arr.first());
                if let Some(s) = current {
                    if let Some(pn) = s.get("productName").and_then(|x| x.as_str()) {
                        if !pn.trim().is_empty() {
                            product_name = Some(pn.to_string());
                            plan_tier = Some(tier_from_level(pn));
                        }
                    }
                    plan_expire = extract_expire(s);
                    plan_start = extract_start(s);
                }
            }
        }
    }

    let main = main.or_else(|| items.iter().find(|i| i.total.is_some()).cloned());
    let (total, used, remaining, percent_used) = match &main {
        Some(m) => (m.total, m.used, m.remaining, m.percent_used),
        None => {
            let p = items.iter().find_map(|i| i.percent_used);
            (None, None, None, p)
        }
    };

    let plans = if plan_tier.is_some() || !items.is_empty() {
        vec![PlanSlot {
            pid: String::new(),
            tier: plan_tier.clone(),
            tier_code: plan_tier.as_deref().map(tier_code_from_display),
            name: product_name,
            expire: plan_expire.clone(),
            starts: plan_start.clone(),
            total,
            used,
            remaining,
            percent_used,
            items: items.clone(),
        }]
    } else {
        vec![]
    };

    QuotaOverview {
        total,
        used,
        remaining,
        percent_used,
        plan_tier,
        plan_expire,
        plan_starts: plan_start,
        is_empty: limits.is_empty(),
        items,
        refreshed_at: 0,
        source: String::new(),
        plans,
    }
}

fn unwrap(data: &Value) -> Value {
    let mut cur = data.clone();
    for _ in 0..4 {
        if !cur.is_object() {
            return cur;
        }
        if let Some(d) = cur.get("data") {
            cur = d.clone();
            continue;
        }
        if let Some(r) = cur.get("result") {
            cur = r.clone();
            continue;
        }
        break;
    }
    cur
}

fn flatten_numbers(obj: &Value, prefix: &str, out: &mut Vec<(String, f64)>) {
    if let Some(m) = obj.as_object() {
        for (k, v) in m {
            let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            if let Some(n) = to_number(v) {
                out.push((p, n));
            } else {
                flatten_numbers(v, &p, out);
            }
        }
    } else if let Some(arr) = obj.as_array() {
        for (i, v) in arr.iter().enumerate() {
            let p = format!("{prefix}.{i}");
            if let Some(n) = to_number(v) {
                out.push((p, n));
            } else {
                flatten_numbers(v, &p, out);
            }
        }
    }
}

fn to_number(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return if n.is_finite() { Some(n) } else { None };
    }
    if let Some(s) = v.as_str() {
        let t = s.replace(',', "");
        return t.trim().parse::<f64>().ok();
    }
    None
}

fn sum_numbers(pool: &[(String, f64)], keys: &[&str]) -> Option<f64> {
    let mut total = 0.0;
    let mut count = 0;
    for (path, v) in pool {
        let name = path.rsplit('.').next().unwrap_or("");
        if keys.contains(&name) {
            total += v;
            count += 1;
        }
    }
    if count > 0 { Some(total) } else { None }
}

fn first_number(pool: &[(String, f64)], keys: &[&str]) -> Option<f64> {
    for (path, v) in pool {
        let name = path.rsplit('.').next().unwrap_or("");
        if keys.contains(&name) {
            return Some(*v);
        }
    }
    None
}

pub fn extract_plan_tier(current_data: &Value) -> Option<String> {
    let cur = unwrap(current_data);
    let plans = cur.get("plans").and_then(|p| p.as_array())?;
    let active: Vec<&Value> = plans
        .iter()
        .filter(|p| p.get("status").and_then(|s| s.as_str()).unwrap_or("").to_lowercase() == "active")
        .collect();
    if active.is_empty() {
        return None;
    }
    let matches = |kw: &[&str]| {
        active.iter().any(|p| {
            let id = p.get("plan_id").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            kw.iter().any(|k| id.contains(k) || name.contains(k))
        })
    };
    if matches(&["max"]) {
        Some("Max".into())
    } else if matches(&["pro"]) {
        Some("Pro".into())
    } else if matches(&["lite"]) {
        Some("Lite".into())
    } else if matches(&["start-plan", "start plan", "start"]) {
        Some("Start Plan".into())
    } else {
        None
    }
}

fn plan_tier_from_id(plan_id: &str, name: Option<&str>) -> (String, String) {
    let mut hay = plan_id.to_lowercase();
    if let Some(n) = name {
        hay.push(' ');
        hay.push_str(&n.to_lowercase());
    }
    if hay.contains("max") {
        ("Max".into(), "max".into())
    } else if hay.contains("pro") {
        ("Pro".into(), "pro".into())
    } else if hay.contains("lite") {
        ("Lite".into(), "lite".into())
    } else if ["weekend", "referral", "trial", "taste", "experience", "gift", "promo", "activity", "体验"]
        .iter()
        .any(|k| hay.contains(k))
    {
        // 临时活动桶先于 start 判定：zai 活动桶的 plan_id 恒含 "start-plan"（如 1030-wk），
        // 放在 start 之后 weekend 分支永不命中
        ("体验".into(), "trial".into())
    } else if hay.contains("start") {
        ("Start Plan".into(), "start".into())
    } else {
        (plan_id.to_string(), "other".into())
    }
}

fn tier_code_from_display(tier: &str) -> String {
    let t = tier.to_lowercase();
    if t.contains("max") {
        "max".into()
    } else if t.contains("pro") {
        "pro".into()
    } else if t.contains("lite") {
        "lite".into()
    } else if t.contains("start") {
        "start".into()
    } else if t.contains("trial") || tier.contains("体验") {
        "trial".into()
    } else {
        "other".into()
    }
}

fn tier_rank(code: Option<&str>) -> u8 {
    match code.unwrap_or("") {
        "max" => 5,
        "pro" => 4,
        "lite" => 3,
        "start" => 2,
        "trial" => 1,
        _ => 0,
    }
}

/// 重复条目合并时的字段累加：任一侧缺失即视为缺失（None 不冒充 0）
fn add_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x + y),
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (None, None) => None,
    }
}

fn normalize_balance(balance_data: &Value) -> QuotaOverview {
    let balance = unwrap(balance_data);
    if std::env::var("ZSW_DUMP_SUB").is_ok() {
        eprintln!("[zsw] billing/balance raw: {balance_data}");
    }
    let mut pool = vec![];
    flatten_numbers(&balance, "", &mut pool);

    let mut slots: Vec<PlanSlot> = balance
        .get("plans")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|pl| {
                    pl.get("status")
                        .and_then(|s| s.as_str())
                        .map(|s| s.eq_ignore_ascii_case("active"))
                        .unwrap_or(false)
                })
                .map(|pl| {
                    let pid = pl.get("plan_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let pname = pl.get("name").and_then(|v| v.as_str()).map(str::to_string);
                    let (tier, tier_code) = plan_tier_from_id(&pid, pname.as_deref());
                    PlanSlot {
                        pid: pid.clone(),
                        tier: Some(tier),
                        tier_code: Some(tier_code),
                        name: Some(pname.filter(|s| !s.trim().is_empty()).unwrap_or(pid)),
                        expire: extract_expire(pl),
                        starts: extract_start(pl),
                        ..Default::default()
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // 夜间桶标记：entitlements.period == "daily_night" 的计划（referral 夜卡，
    // 当晚 23:00 → 次晨 09:00），给对应桶条目打 window 标签供 UI 区分于日常额度
    let night_pids: std::collections::HashSet<String> = balance
        .get("plans")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|pl| {
                    pl.get("entitlements")
                        .and_then(|e| e.as_array())
                        .map(|es| {
                            es.iter().any(|e| e.get("period").and_then(|v| v.as_str()) == Some("daily_night"))
                        })
                        .unwrap_or(false)
                })
                .filter_map(|pl| pl.get("plan_id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut loose: Vec<QuotaItem> = vec![];

    // balances[] 已覆盖的套餐 ID 集合：桶兑底只兜「服务端没给桶行」的套餐。
    // 兜底判据不能用「槽 items 是否为空」——balances 在兑底之后才处理，items 恒空，
    // 守卫会失效导致 grant 与桶行按 show_name 合并双计（2026-11-07 实测：周包 5 亿被显示为 10 亿）。
    let covered_pids: std::collections::HashSet<String> = balance
        .get("balances")
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    ["plan_id", "planId"]
                        .iter()
                        .find_map(|k| item.get(k).and_then(Value::as_str).map(str::to_string))
                })
                .collect()
        })
        .unwrap_or_default();
    // 桶行只带 entitlement_id 时的兜底判据：权益 ID 落在本套餐的 entitlements 里同样算已覆盖
    let covered_eids: std::collections::HashSet<String> = balance
        .get("balances")
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("entitlement_id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let plan_eids = |pid: &str| -> Vec<String> {
        balance
            .get("plans")
            .and_then(|p| p.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|pl| pl.get("plan_id").and_then(Value::as_str) == Some(pid))
                    .and_then(|pl| pl.get("entitlements").and_then(Value::as_array))
                    .map(|es| {
                        es.iter()
                            .filter_map(|e| e.get("entitlement_id").and_then(Value::as_str).map(str::to_string))
                            .collect()
                    })
            })
            .unwrap_or_default()
    };

    // 桶兑底：balances[] 为空时（新领批次未消费，服务端只在 entitlements 里报 grant），
    // 从对应计划的 entitlements 合成桶条目——total=grant_units、remaining=grant_units；
    // 该套餐已有桶行则跳过（避免与用量行双计）。daily_night 桶打夜间窗口标签
    for s in &mut slots {
        if !s.items.is_empty()
            || covered_pids.contains(&s.pid)
            || plan_eids(&s.pid).iter().any(|eid| covered_eids.contains(eid))
        {
            continue;
        }
        let ents = balance
            .get("plans")
            .and_then(|p| p.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|pl| pl.get("plan_id").and_then(Value::as_str) == Some(s.pid.as_str()))
                    .and_then(|pl| pl.get("entitlements").and_then(Value::as_array))
                    .cloned()
            })
            .unwrap_or_default();
        for e in ents {
            let total = e.get("grant_units").and_then(to_number);
            let Some(total) = total else { continue };
            let period = e.get("period").and_then(Value::as_str).unwrap_or("");
            s.items.push(QuotaItem {
                name: e.get("show_name").and_then(Value::as_str).unwrap_or("Unknown").to_string(),
                total: Some(total),
                used: None,
                remaining: Some(total),
                percent_used: None,
                server_percentage: None,
                unit: e.get("unit_type").and_then(Value::as_str).unwrap_or("quota").to_string(),
                period_end: None,
                window: if period == "daily_night" { Some("夜间".into()) } else { None },
                ..Default::default()
            });
        }
    }

    let any_pid = balance
        .get("balances")
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter().any(|item| {
                ["plan_id", "planId", "entitlement_id"]
                    .iter()
                    .any(|k| item.get(k).and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false))
            })
        })
        .unwrap_or(false);
    if let Some(arr) = balance.get("balances").and_then(|b| b.as_array()) {
        for item in arr {
            let it_total = item.get("total_units").and_then(to_number);
            let it_used = item.get("used_units").and_then(to_number);
            let it_remaining = item
                .get("remaining_units")
                .and_then(to_number)
                .or_else(|| item.get("available_units").and_then(to_number));
            let bpid = ["plan_id", "planId", "entitlement_id"]
                .iter()
                .find_map(|k| item.get(k).and_then(Value::as_str))
                .unwrap_or("");
            let it = QuotaItem {
                name: ["show_name", "name", "entitlement_id", "plan_id"]
                    .iter()
                    .find_map(|k| item.get(k).and_then(Value::as_str))
                    .unwrap_or("Unknown")
                    .to_string(),
                total: it_total,
                used: it_used,
                remaining: it_remaining,
                percent_used: match (it_total, it_used) {
                    (Some(t), Some(u)) if t > 0.0 => Some((u / t * 100.0).clamp(0.0, 100.0)),
                    _ => None,
                },
                server_percentage: None,
                unit: item.get("unit_type").or_else(|| item.get("meter")).and_then(Value::as_str).unwrap_or("quota").to_string(),
                period_end: ["period_end", "expires_at"].iter().find_map(|k| item.get(k).and_then(expiry_field)),
                window: if night_pids.contains(bpid) { Some("夜间".into()) } else { None },
                ..Default::default()
            };
            let target = if !bpid.is_empty() {
                slots.iter_mut().find(|s| s.pid == bpid)
            } else if slots.len() == 1 && !any_pid {
                slots.first_mut()
            } else {
                None
            };
            match target {
                Some(s) => {
                    if s.expire.is_none() {
                        s.expire = extract_expire(item);
                    }
                    // 同槽内重复条目（上游 #30：同源渠道吐多行同模型）按 show_name 合并：
                    // 保留首次出现的元数据，total/used/remaining 累加
                    if let Some(prev) = s.items.iter_mut().find(|prev| prev.name == it.name) {
                        prev.total = add_opt(prev.total, it.total);
                        prev.used = add_opt(prev.used, it.used);
                        prev.remaining = add_opt(prev.remaining, it.remaining);
                        prev.percent_used = match (prev.total, prev.used) {
                            (Some(t), Some(u)) if t > 0.0 => Some((u / t * 100.0).clamp(0.0, 100.0)),
                            _ => prev.percent_used,
                        };
                    } else {
                        s.items.push(it);
                    }
                }
                None => loose.push(it),
            }
        }
    }

    if slots.is_empty() {
        if !loose.is_empty() {
            let t = extract_plan_tier(balance_data);
            slots.push(PlanSlot {
                tier_code: t.as_deref().map(tier_code_from_display),
                tier: t,
                items: std::mem::take(&mut loose),
                ..Default::default()
            });
        } else {
            let ptot = sum_numbers(&pool, &["total_units"]).or_else(|| {
                first_number(&pool, &["total", "totalQuota", "totalCredits", "quotaTotal", "amountTotal", "creditTotal"])
            });
            let pused = sum_numbers(&pool, &["used_units"]).or_else(|| {
                first_number(&pool, &["used", "usedQuota", "usedCredits", "quotaUsed", "amountUsed", "consumed", "totalUsed"])
            });
            let prem = sum_numbers(&pool, &["remaining_units"]).or_else(|| {
                first_number(&pool, &["remaining", "remain", "balance", "available", "availableQuota", "left", "quotaRemaining"])
            });
            if ptot.is_some() || pused.is_some() || prem.is_some() {
                let t = extract_plan_tier(balance_data);
                slots.push(PlanSlot {
                    tier_code: t.as_deref().map(tier_code_from_display),
                    tier: t,
                    total: ptot,
                    used: pused,
                    remaining: prem,
                    ..Default::default()
                });
            }
        }
    } else if !loose.is_empty() {
        slots.push(PlanSlot {
            name: Some("其他额度".into()),
            tier_code: Some("other".into()),
            items: loose,
            ..Default::default()
        });
    }

    for s in &mut slots {
        let sum = |f: fn(&QuotaItem) -> Option<f64>| -> Option<f64> {
            let vals: Vec<f64> = s.items.iter().filter_map(f).collect();
            (!vals.is_empty()).then(|| vals.iter().sum())
        };
        if s.items.is_empty() && s.total.is_none() {
            continue;
        }
        s.total = sum(|i| i.total).or(s.total);
        s.used = sum(|i| i.used).or(s.used);
        s.remaining = sum(|i| i.remaining).or(s.remaining);
        if s.total.is_none() {
            if let (Some(u), Some(r)) = (s.used, s.remaining) {
                s.total = Some(u + r);
            }
        }
        if s.used.is_none() {
            if let (Some(t), Some(r)) = (s.total, s.remaining) {
                s.used = Some((t - r).max(0.0));
            }
        }
        if s.remaining.is_none() {
            if let (Some(t), Some(u)) = (s.total, s.used) {
                s.remaining = Some((t - u).max(0.0));
            }
        }
        if s.percent_used.is_none() {
            s.percent_used = match (s.total, s.used) {
                (Some(t), Some(u)) if t > 0.0 => Some((u / t * 100.0).clamp(0.0, 100.0)),
                _ => None,
            };
        }
    }
    // 主槽优先：档位高者胜；同档时常驻套餐（非 -wk/referral 临时桶）胜，
    // 否则服务端把临时桶排前导致头条数字显示转瞬即逝的活动桶
    let pri_rank = |s: &PlanSlot| {
        let transient = s.pid.contains("-wk") || s.pid.contains("referral");
        (tier_rank(s.tier_code.as_deref()), !transient)
    };
    let mut pri_idx = 0usize;
    for (i, s) in slots.iter().enumerate() {
        if pri_rank(s) > pri_rank(&slots[pri_idx]) {
            pri_idx = i;
        }
    }

    let items: Vec<QuotaItem> = slots.iter().flat_map(|s| s.items.iter().cloned()).collect();

    let plan_expire_chain = extract_expire(&balance)
        .or_else(|| {
            balance.get("plans").and_then(|p| p.as_array()).and_then(|arr| {
                arr.iter()
                    .find(|pl| pl.get("status").and_then(|s| s.as_str()).map(|s| s.eq_ignore_ascii_case("active")).unwrap_or(false))
                    .and_then(extract_expire)
                    .or_else(|| arr.first().and_then(extract_expire))
            })
        })
        .or_else(|| {
            balance.get("balances").and_then(|b| b.as_array()).and_then(|arr| {
                arr.iter()
                    .filter_map(|it| it.get("expires_at").and_then(|v| v.as_i64()))
                    .filter(|n| *n > 1_000_000_000)
                    .max()
                    .and_then(|n| {
                        use chrono::TimeZone;
                        chrono::Local.timestamp_opt(n, 0).single().map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                    })
            })
        })
        .or_else(|| items.iter().find_map(|i| i.period_end.clone().filter(|s| !s.is_empty())));

    if slots.len() == 1 && slots[0].expire.is_none() {
        slots[0].expire = plan_expire_chain.clone();
    }
    let (total, used, remaining, percent_used) = match slots.get(pri_idx) {
        Some(p) => (p.total, p.used, p.remaining, p.percent_used),
        None => {
            let p = items.iter().find_map(|i| i.percent_used);
            (None, None, None, p)
        }
    };

    // 空额度判定同时看桶与计划：-wk 批次 19:00 领取后 plans[] 已 active，
    // 但额度桶要到 effective_at（实测 23:00）才下发，此窗口内桶空不等于无额度
    let buckets_empty = balance
        .get("balances")
        .and_then(|b| b.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(false);
    let plans_empty = balance
        .get("plans")
        .and_then(|p| p.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(false);

    QuotaOverview {
        total,
        used,
        remaining,
        percent_used,
        plan_tier: slots.get(pri_idx).and_then(|p| p.tier.clone()),
        plan_expire: slots.get(pri_idx).and_then(|p| p.expire.clone()).or(plan_expire_chain),
        plan_starts: slots.get(pri_idx).and_then(|p| p.starts.clone()),
        is_empty: buckets_empty && plans_empty,
        items,
        refreshed_at: 0,
        source: String::new(),
        plans: slots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-11-07 实测响应（ShannonYoung8131 周包，used=0）：
    /// 兑底不得与 balances[] 桶行按 show_name 合并双计——total 必须是 5 亿不是 10 亿
    #[test]
    fn balance_no_double_count_when_balances_present() {
        let resp = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1794010672,
                "plans": [{
                    "user_plan_id": "upl_2118665624914460672",
                    "plan_id": "zcode-v3-start-plan-1106-wk",
                    "name": "ZCODE WEEKEND BUILD",
                    "description": "", "priority": 101, "status": "active",
                    "starts_at": 1793964222, "ends_at": 1794186000,
                    "entitlements": [{
                        "entitlement_id": "ent-zcode-v3-start-plan-1106-wk-1",
                        "show_name": "GLM-5.3-Flash", "meter": "model_usage",
                        "unit_type": "token", "capabilities": ["model:glm-5.3-flash"],
                        "grant_units": 500000000u64, "period": "one_time",
                        "priority": 101, "effective_at": 1793977200
                    }]
                }],
                "balances": [{
                    "bucket_id": "bucket_2118721319940620288",
                    "user_plan_id": "upl_2118665624914460672",
                    "plan_id": "zcode-v3-start-plan-1106-wk",
                    "entitlement_id": "ent-zcode-v3-start-plan-1106-wk-1",
                    "show_name": "GLM-5.3-Flash", "meter": "model_usage",
                    "unit_type": "token", "capabilities": ["model:glm-5.3-flash"],
                    "priority": 101, "plan_priority": 101, "entitlement_priority": 101,
                    "total_units": 500000000u64, "used_units": 0u64,
                    "remaining_units": 500000000u64, "available_units": 500000000u64,
                    "period_start": 1793964222, "period_end": 1794186000,
                    "expires_at": 1794186000
                }]
            }, "logid": "t"
        });
        let ov = normalize_balance(&resp);
        let slot = ov.plans.iter().find(|s| s.pid == "zcode-v3-start-plan-1106-wk").expect("slot");
        assert_eq!(slot.items.len(), 1, "桶行与兑底条目被合并双计");
        let it = &slot.items[0];
        assert_eq!(it.total, Some(500_000_000.0), "total 双计: {:?}", it.total);
        assert_eq!(it.remaining, Some(500_000_000.0), "remaining 双计: {:?}", it.remaining);
        assert_eq!(it.used, Some(0.0));
    }

    /// balances[] 整体为空时兑底仍要生效（服务端只在 entitlements 报 grant 的场景）
    #[test]
    fn balance_fallback_still_works_without_buckets() {
        let resp = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1,
                "plans": [{
                    "plan_id": "p1", "name": "PLAN", "priority": 1, "status": "active",
                    "entitlements": [{
                        "entitlement_id": "e1", "show_name": "GLM-5.3-Flash",
                        "unit_type": "token", "grant_units": 123u64, "period": "one_time"
                    }]
                }],
                "balances": []
            }
        });
        let ov = normalize_balance(&resp);
        let slot = ov.plans.iter().find(|s| s.pid == "p1").expect("slot");
        assert_eq!(slot.items.len(), 1);
        assert_eq!(slot.items[0].total, Some(123.0));
        assert_eq!(slot.items[0].remaining, Some(123.0));
    }

    /// bigmodel 兑底腿·订阅先行（2026-11-08）：balance 失败进兑底后，订阅为空
    /// （无在期 coding 套餐）→ 直接定论无套餐，monitor 用量接口不得再打
    #[test]
    fn bigmodel_fallback_gated_by_subscription_empty() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::<String>::new());
        let fetch = |url: &str, _t: &str| -> Result<Value, String> {
            calls.borrow_mut().push(url.to_string());
            if url.starts_with(BILLING_BALANCE_URL) {
                Ok(json!({ "code": 1005, "msg": "quota exhausted" }))
            } else if url == SUBSCRIPTION_URL {
                Ok(json!({ "code": 0, "msg": "", "data": [] }))
            } else if url == QUOTA_LIMIT_URL {
                Ok(json!({ "code": 401, "msg": "令牌已过期或验证不正确", "success": false }))
            } else {
                Ok(json!({}))
            }
        };
        let ov = query_with_token_via("t", &fetch).expect("订阅空应定论无套餐");
        assert!(ov.is_empty && ov.source == "no_plan", "source={}", ov.source);
        assert!(
            !calls.borrow().iter().any(|u| u == QUOTA_LIMIT_URL),
            "订阅为空不得打 monitor 用量接口"
        );
    }

    /// 订阅有在期 coding 套餐 → 才打 monitor，且订阅响应复用做套餐名/到期增强
    #[test]
    fn bigmodel_monitor_probed_only_after_subscription_confirms() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::<String>::new());
        let fetch = |url: &str, _t: &str| -> Result<Value, String> {
            calls.borrow_mut().push(url.to_string());
            if url.starts_with(BILLING_BALANCE_URL) {
                Ok(json!({ "code": 1005, "msg": "quota exhausted" }))
            } else if url == SUBSCRIPTION_URL {
                Ok(json!({ "code": 0, "msg": "", "data": [{
                    "productId": "glm-coding-plan", "productName": "glm coding plan",
                    "inCurrentPeriod": true, "status": "VALID"
                }] }))
            } else if url == QUOTA_LIMIT_URL {
                Ok(json!({ "code": 0, "msg": "", "data": { "level": "pro", "limits": [] } }))
            } else {
                Ok(json!({}))
            }
        };
        let ov = query_with_token_via("t", &fetch).expect("有订阅应产出 monitor 概览");
        assert_eq!(ov.source, "bigmodel.cn/api/monitor");
        assert!(calls.borrow().iter().any(|u| u == QUOTA_LIMIT_URL));
    }

    /// 订阅业务 401（令牌已过期）→ 同 token 同 host，monitor 必然同样结局，不再白打
    #[test]
    fn bigmodel_fallback_auth401_short_circuits_monitor() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::<String>::new());
        let fetch = |url: &str, _t: &str| -> Result<Value, String> {
            calls.borrow_mut().push(url.to_string());
            if url.starts_with(BILLING_BALANCE_URL) {
                Ok(json!({ "code": 1005, "msg": "quota exhausted" }))
            } else if url == SUBSCRIPTION_URL {
                Ok(json!({ "code": 401, "msg": "令牌已过期或验证不正确", "success": false }))
            } else if url == QUOTA_LIMIT_URL {
                Ok(json!({ "code": 0, "msg": "", "data": { "level": "pro", "limits": [] } }))
            } else {
                Ok(json!({}))
            }
        };
        let err = query_with_token_via("t", &fetch).expect_err("订阅 401 应报 token 失效");
        assert!(err.contains("401"), "err={err}");
        assert!(
            !calls.borrow().iter().any(|u| u == QUOTA_LIMIT_URL),
            "订阅 401 后 monitor 不应再打"
        );
    }
}
