
use crate::quota;
use crate::zcrypto;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub const BILLING_CLAIM_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";
pub const CLIENT_CONFIGS_URL: &str = "https://zcode.z.ai/api/v1/client/configs";
pub const MARKETING_TOUCH_URL: &str = "https://zcode.z.ai/api/v1/marketing/touch";
pub const MARKETING_TOUCH_ACTION_URL: &str = "https://zcode.z.ai/api/v1/marketing/touch/action";

/// touch 查询序号：桌面端为模块级递增计数器（asar 实锤 `Xde=0, seq=String(Xde++)`，
/// 首查发 0），非固定值——对齐之，避免服务端按 seq 去重时我们恒撞同一序号。
static TOUCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const CLAIM_TIMEOUT_SECS: u64 = 25;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClaimGrant {
    pub name: String,
    pub units: f64,
    pub period: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClaimPlan {
    pub plan_id: String,
    pub name: String,
    pub description: String,
    pub priority: i64,
    pub grants: Vec<String>,
    #[serde(default)]
    pub grant_items: Vec<ClaimGrant>,
    /// 投放 campaign 标识：领取成功后上报 touch/action 用（桌面端对齐，11-03 asar 实锤）
    #[serde(default)]
    pub campaign_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptchaConfig {
    pub enabled: bool,
    pub region: String,
    pub prefix: String,
    pub scene_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub account_id: String,
    pub account_name: String,
    pub plan_name: String,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub server_time: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ClaimError {
    pub code: i64,
    pub message: String,
    pub next_at: Option<i64>,
}

impl From<String> for ClaimError {
    fn from(message: String) -> Self {
        ClaimError {
            code: -1,
            message,
            next_at: None,
        }
    }
}

fn claim_error(code: i64, body: &Value) -> ClaimError {
    // 桌面对齐（11-03 asar 实锤）：任意失败码都回读 data.plan.ends_at 作 failureEndsAt
    // （计划期结束时间，前端冷却展示的权威值）——桌面端不按错误码分流，字段缺席时自然为 None
    let next_at = body
        .pointer("/data/plan/ends_at")
        .and_then(|x| x.as_i64())
        .map(|s| s * 1000);
    ClaimError {
        code,
        message: failure_message(code, body),
        next_at,
    }
}

pub fn failure_payload(
    account_id: &str,
    account_name: &str,
    plan_name: &str,
    err: &ClaimError,
) -> Value {
    serde_json::json!({
        "ok": false,
        "accountId": account_id,
        "accountName": account_name,
        "planName": plan_name,
        "code": err.code,
        "nextAt": err.next_at,
        "message": err.message,
    })
}

pub(crate) fn claim_token(creds: &Value, config: Option<&Value>, secret: &str) -> Result<String, String> {
    let jwt = creds
        .get("zcodejwttoken")
        .and_then(|v| v.as_str())
        .and_then(|v| decrypt_credential(v, secret));
    if let Some(t) = jwt.filter(|t| t.trim().len() > 20) {
        return Ok(t);
    }
    if let Some(t) = quota::zai_billing_token(creds, config, secret) {
        return Ok(t);
    }
    Err(crate::i18n::tr("err.claim.no_jwt"))
}

fn decrypt_credential(v: &str, secret: &str) -> Option<String> {
    if zcrypto::is_encrypted(v) {
        zcrypto::decrypt_with_secret(v, secret).ok()
    } else {
        Some(v.to_string())
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(CLAIM_TIMEOUT_SECS))
        .build()
}

/// 账号的 user id（来自 oauth user_info 快照）。缺它说明快照不完整（旧版保存的登录），
/// UI 据此标「需重新登录」。
pub(crate) fn oauth_user_id(home: &Path, creds: &Value) -> Option<String> {
    let secret = zcrypto::default_secret(home);
    let provider = creds
        .get("oauth:active_provider")
        .and_then(|v| v.as_str())
        .and_then(|v| decrypt_credential(v, &secret))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "zai".to_string());
    let raw = creds
        .get(format!("oauth:{provider}:user_info"))?
        .as_str()?;
    let plain = decrypt_credential(raw, &secret)?;
    let info: Value = serde_json::from_str(&plain).ok()?;
    let pick = |k: &str| {
        info.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    pick("id").or_else(|| pick("user_id")).map(String::from)
}

/// 该号当前可领的套餐清单：唯一来源是 `marketing/touch` 投放。
/// `billing/preview` 通道已整体删除（50 §3 实测恒空，五个已领到的号也一样空，
/// 还是已知会 429 的端点——留着每次刷新只多一个必死请求）。
pub fn claimable_plans(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    device_mid: Option<String>,
) -> Result<Vec<ClaimPlan>, String> {
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    // touch 失败（429/网络错）原样上抛，不吞成「无投放」：前端走 catch 保留
    // 既有可领条，而不是拿一个被限流污染的空结果把刚刷出来的资格顶掉
    let mut plans = touch_plans(&token, device_mid)?;
    plans.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.plan_id.cmp(&b.plan_id)));
    Ok(plans)
}

/// 营销触点投放：`buttons[].action.type == "claim_zcode_plan"` 才是「该号当前可领」的
/// 权威信号（实测 preview 恒空，五个已领到的号也一样空）。
/// 投放壳有两种（60 §3）：`resource_position` = `"banner" | "popup"`，按钮与权益分别挂在
/// `banner` 子壳与投放根上，所以两处都要扫——只认 banner 的话，服务端改用 popup 投领取卡
/// 会被静默漏掉。
/// 此端点对 app_version 敏感——老版本头（如 3.14.0）实测返回空 deliveries，必须走真实客户端版本头。
/// 投放按 mid + 账号双重分配，mid 用该号自己的。
/// 失败一律 Err 上抛而非吞成空列表：调用方要区分「确认无投放」和「这次没查着」，
/// 后者冒充前者会把限流期间的空响应当权威结论，顶掉前端已展示的可领条
fn touch_plans(token: &str, mid: Option<String>) -> Result<Vec<ClaimPlan>, String> {
    let seq = TOUCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let url = format!(
        "{MARKETING_TOUCH_URL}?seq={seq}&app_version={}&platform={}",
        quota::zcode_app_version(),
        quota::client_platform()
    );
    let mut req = agent().get(&url);
    for (k, v) in quota::zai_billing_headers_with_mid(token, mid) {
        req = req.set(&k, &v);
    }
    let resp = req
        .call()
        .map_err(|e| http_err(&crate::i18n::tr("err.claim.touch_req"), e))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp)
        .map_err(|e| crate::i18n::trf("err.http.parse", &[("e", &e.to_string())]))?;
    let dels = v
        .pointer("/data/deliveries")
        .and_then(|d| d.as_array())
        .cloned()
        .ok_or_else(|| crate::i18n::tr("err.claim.touch_shape"))?;
    let mut out: Vec<ClaimPlan> = vec![];
    for d in &dels {
        // report 需要的投放 campaign 标识（桌面端领取成功后 POST touch/action 用）
        let dl_campaign = ["campaign_id", "campaignId"]
            .iter()
            .find_map(|k| {
                d.get(k)
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            });
        let mut wanted: Vec<String> = vec![];
        for node in [d.get("banner"), Some(d)].into_iter().flatten() {
            let Some(arr) = node.get("buttons").and_then(|b| b.as_array()) else {
                continue;
            };
            for plan_id in arr.iter().filter_map(|b| {
                let act = b.get("action")?;
                if act.get("type").and_then(|t| t.as_str()) != Some("claim_zcode_plan") {
                    return None;
                }
                act.get("args")
                    .and_then(|a| a.get("plan_id").or_else(|| a.get("planId")))
                    .and_then(|p| p.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            }) {
                if !wanted.contains(&plan_id) {
                    wanted.push(plan_id);
                }
            }
        }
        if wanted.is_empty() {
            continue;
        }
        // bundle.args.zcode_plan 与 preview 的 plan 同构，带 entitlements/priority。
        // 实测结构：background = { bundle:{src}, entry, args:{zcode_plan} } —— args 与 bundle 同级
        // popup 壳没有 banner 前缀，四条路径按存在取第一条
        let zp = [
            "/banner/background/args/zcode_plan",
            "/banner/background/bundle/args/zcode_plan",
            "/background/args/zcode_plan",
            "/background/bundle/args/zcode_plan",
        ]
        .iter()
        .find_map(|p| d.pointer(p));
        let mut matched = false;
        if let Some(p) = zp {
            let pid = p
                .get("plan_id")
                .or_else(|| p.get("planId"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !pid.is_empty() && wanted.iter().any(|w| *w == pid) {
                if let Some(mut plan) = parse_plan(p) {
                    plan.campaign_id = dl_campaign.clone();
                    out.push(plan);
                    matched = true;
                }
            }
        }
        if !matched {
            for pid in wanted {
                if out.iter().any(|p| p.plan_id == pid) {
                    continue;
                }
                out.push(ClaimPlan {
                    name: pid.clone(),
                    description: String::new(),
                    priority: 0,
                    plan_id: pid,
                    grants: vec![],
                    grant_items: vec![],
                    campaign_id: dl_campaign.clone(),
                });
            }
        }
    }
    Ok(out)
}

pub(crate) fn http_err(prefix: &str, e: ureq::Error) -> String {
    if let ureq::Error::Status(code, resp) = e {
        let body = resp.into_string().unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| ["msg", "message", "error"]
                .iter()
                .find_map(|k| v.get(k).and_then(|x| x.as_str()).map(String::from)))
            .unwrap_or_default();
        // 完整响应体附在第二行（截 750 字符保 UTF-8 边界）：前端 toast 收起显示短句，点开展开看全文
        let body = body.trim();
        if body.is_empty() {
            return format!("{prefix} HTTP {code}: {msg}");
        }
        let cut = body.char_indices().nth(750).map(|(i, _)| i).unwrap_or(body.len());
        let clipped = &body[..cut];
        return format!("{prefix} HTTP {code}: {msg}\n{clipped}");
    }
    format!("{prefix} {e}")
}


pub fn submit_claim(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    plan_id: &str,
    captcha_param: &str,
    captcha_region: Option<&str>,
    device_mid: Option<String>,
) -> Result<Value, ClaimError> {
    if captcha_param.trim().is_empty() {
        return Err(crate::i18n::tr("err.claim.no_captcha").into());
    }
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    let mut req = agent().post(BILLING_CLAIM_URL);
    // 领取版本头跟投放读取通道同档（探测值）：投放按 app_version 过滤，
    // 低一档自述会被服务端当「该档无此投放」→ 1004。详见 quota::zai_claim_headers_with_mid
    for (k, v) in quota::zai_claim_headers_with_mid(&token, device_mid) {
        req = req.set(&k, &v);
    }
    req = req.set("X-Aliyun-Captcha-Verify-Param", captcha_param.trim());
    if let Some(r) = captcha_region.filter(|r| !r.trim().is_empty()) {
        req = req.set("X-Aliyun-Captcha-Verify-Region", r.trim());
    }
    let resp = req
        .send_json(serde_json::json!({ "plan_id": plan_id }))
        .map_err(|e| ClaimError {
            code: -1,
            message: http_err(&crate::i18n::tr("err.claim.claim_req"), e),
            next_at: None,
        })?
        .into_string()
        .map_err(|e| ClaimError {
            code: -1,
            message: crate::i18n::trf("err.http.read", &[("e", &e.to_string())]),
            next_at: None,
        })?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Err(claim_error(code, &v));
    }
    Ok(v)
}

/// 桌面对齐（11-03 asar 实锤）：领取后上报投放动作。action_type = confirm（领取）/ cancel（忽略）。
/// 纯遥测形状——失败不上抛到领取结果，调用方记日志即可。载荷 {campaign_id, action_type}，
/// 响应 {code:0}；超时 15s（桌面端同值）。
pub fn touch_report(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    campaign_id: &str,
    action_type: &str,
    device_mid: Option<String>,
) -> Result<(), String> {
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    let mut req = agent().post(MARKETING_TOUCH_ACTION_URL);
    for (k, v) in quota::zai_claim_headers_with_mid(&token, device_mid) {
        req = req.set(&k, &v);
    }
    let resp = req
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send_json(serde_json::json!({
            "campaign_id": campaign_id,
            "action_type": action_type,
        }))
        .map_err(|e| http_err("marketing/touch/action", e))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::Null);
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Err(format!("code={code}"));
    }
    Ok(())
}

pub fn fetch_captcha_config() -> Result<CaptchaConfig, String> {    let mut req = agent().get(CLIENT_CONFIGS_URL);
    for (k, v) in quota::zai_billing_headers("") {
        req = req.set(&k, &v);
    }
    let resp = req
        .call()
        .map_err(|e| crate::i18n::trf("err.claim.config_req", &[("e", &e.to_string())]))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    if v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) != 0 {
        return Err(crate::i18n::tr("err.claim.config_unavailable"));
    }
    let c = v.pointer("/data/configs/captcha").cloned().unwrap_or(Value::Null);
    let s = |k: &str| c.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    Ok(CaptchaConfig {
        enabled: c.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
        region: s("region"),
        prefix: s("prefix"),
        scene_id: s("sceneId"),
    })
}

fn str_field<'a>(e: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    e.get(snake)
        .and_then(|v| v.as_str())
        .or_else(|| e.get(camel).and_then(|v| v.as_str()))
}

fn num_field(e: &Value, snake: &str, camel: &str) -> Option<f64> {
    e.get(snake)
        .and_then(|v| v.as_f64())
        .or_else(|| e.get(camel).and_then(|v| v.as_f64()))
}

fn parse_plan(p: &Value) -> Option<ClaimPlan> {
    let plan_id = str_field(p, "plan_id", "planId")?.trim().to_string();
    if plan_id.is_empty() {
        return None;
    }
    let grant_items: Vec<ClaimGrant> = p
        .get("entitlements")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|e| {
                    str_field(e, "meter", "meter") == Some("model_usage")
                        && str_field(e, "unit_type", "unitType") == Some("token")
                        && str_field(e, "show_name", "showName")
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false)
                })
                .map(|e| ClaimGrant {
                    name: str_field(e, "show_name", "showName").unwrap_or("").to_string(),
                    units: num_field(e, "grant_units", "grantUnits").unwrap_or(0.0),
                    period: str_field(e, "period", "period").unwrap_or("one_time").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let grants = grant_items
        .iter()
        .map(|g| {
            let period_cn = match g.period.as_str() {
                "daily" => "每日",
                "weekly" => "每周",
                "monthly" => "每月",
                _ => "一次性",
            };
            format!("{} · {} Token（{period_cn}）", g.name, fmt_units(g.units))
        })
        .collect();
    Some(ClaimPlan {
        name: p.get("name").and_then(|s| s.as_str()).unwrap_or("").trim().to_string(),
        description: p
            .get("description")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        priority: p.get("priority").and_then(|x| x.as_i64()).unwrap_or(0),
        plan_id,
        grants,
        grant_items,
        campaign_id: None,
    })
}

fn fmt_units(n: f64) -> String {
    let trim = |x: f64| {
        let r = (x * 10.0).round() / 10.0;
        if (r - r.trunc()).abs() < f64::EPSILON {
            format!("{}", r.trunc() as i64)
        } else {
            format!("{r:.1}")
        }
    };
    if n >= 1e8 {
        format!("{}亿", trim(n / 1e8))
    } else if n >= 1e4 {
        format!("{}万", trim(n / 1e4))
    } else {
        format!("{}", n.round() as i64)
    }
}

pub fn failure_message(code: i64, body: &Value) -> String {
    let server_msg = ["msg", "message"]
        .iter()
        .find_map(|k| body.get(k).and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();
    let base = crate::i18n::tr(match code {
        1001 => "claim.fail.1001",
        1002 => "claim.fail.1002",
        1003 => "claim.fail.1003",
        1004 => "claim.fail.1004",
        1005 => "claim.fail.1005",
        3001 => "claim.fail.3001",
        3007 => "claim.fail.3007",
        401 => "claim.fail.401",
        _ => "claim.fail.generic",
    });
    if server_msg.is_empty() {
        base
    } else {
        crate::i18n::trf("claim.fail.with_server", &[("base", &base), ("server_msg", &server_msg)])
    }
}
