
use crate::quota;
use crate::zcrypto;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

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
    /// 权益真实生效时刻（秒级时间戳，响应原值；None = 响应未给）。
    /// 与活动 starts_at 彻底分开：赠送池常见次日 0 点生效，活动开始时间不能冒充它。
    /// 0 = 立即生效（服务端占位语义）。
    pub effective_at: Option<i64>,
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
    /// 可领条上的权益生效时刻（毫秒级）：取 entitlements 里最早的 effective_at。
    /// None = 响应未给；Some(0) = 立即生效。前端按「字段缺失 → 活动文案兜底」降级。
    #[serde(default)]
    pub effective_at: Option<i64>,
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

/// touch 空 + balance 有「已激活未生效」套餐时的推断态：
/// 领取后投放不再下发，但赠送池桶要等 effective_at 才进 balances[]，这个窗口
/// touch 空 ≠ 无投放，必须由 balance 原始响应反推。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedPending {
    pub account_id: String,
    /// 套餐显示名（balance plans[].name，缺失回 plan_id）
    pub plan_name: String,
    /// 权益生效时刻（毫秒级，最早一条；0 = 立即生效）
    pub effective_at: Option<i64>,
    /// 套餐有效期止（毫秒级）
    pub ends_at: Option<i64>,
    /// 推断依据（source 字段：balance 或 touch）
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub account_id: String,
    pub account_name: String,
    pub plan_name: String,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    /// 权益生效时刻（毫秒级，前端展示权威来源；None = 响应未给）。
    /// effective_at 0 → Some(0) 表示立即生效，前端按此显示「立即生效」而不是隐藏。
    pub effective_at: Option<i64>,
    pub server_time: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ClaimError {
    pub code: i64,
    pub message: String,
    pub next_at: Option<i64>,
    /// HTTP 层状态码：业务层拒绝（HTTP 200 + 业务码）为 200，网络错为 0，未知 -1。
    /// 前端退避分流用——HTTP 429 与业务限流（30xx）是两种不同的惩罚，退避策略不同
    pub http_status: i64,
    /// 业务码（响应体 JSON 的 code 字段）：HTTP 层错误（429/405/5xx）从 body 解析，
    /// 业务层错误直接取。0 = 成功无此字段场景
    pub biz_code: i64,
}

impl From<String> for ClaimError {
    fn from(message: String) -> Self {
        ClaimError {
            code: -1,
            message,
            next_at: None,
            http_status: 0,
            biz_code: -1,
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
        // 业务层拒绝：HTTP 200 + 业务码
        http_status: 200,
        biz_code: code,
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
        "httpStatus": err.http_status,
        "bizCode": err.biz_code,
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
    // 统一记录层：全仓 HTTP 调用经 httplog 的共享 Agent，中间件自动落 flowlog
    // （URL/方法/状态/耗时/响应体截 2K），系统日志页可查
    crate::httplog::logged_agent(CLAIM_TIMEOUT_SECS)
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

/// 领取待生效判定：touch 投放清单为空时，查 billing/balance 原始响应里有没有
/// 「active 且 entitlements 尚未在 balances[] 出现桶行」的套餐。
/// 判据说明：
/// - 不能拿「任意 active 套餐」当已领取——常规订阅永远 active，会误报；
/// - 赠送池（领取类）在生效前 balances[] 无对应桶行，生效后桶出现 → 判定自动消失；
/// - entitlement_id 归属校验防止别的套餐的桶把判定顶掉。
/// balance 抓取失败不阻塞：返回 None（宁可显示空态，不拿错误冒充「无待生效」）。
pub fn claimed_pending(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    device_mid: Option<String>,
    account_id: &str,
) -> Option<ClaimedPending> {
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret).ok()?;
    let balance = quota::fetch_balance_raw(&token, device_mid.as_deref()).ok()?;
    claimed_pending_from_balance(&balance, account_id)
}

/// claimed_pending 的纯函数核心：只依赖 balance 原始响应，不碰网络/凭据。
/// 拆出来是为了单测可钉——判定语义（桶覆盖、effective_at 分级、starts_at
/// 预估不参与跳过）全在这里，fixture 直接用实测响应形状。
pub(crate) fn claimed_pending_from_balance(balance: &Value, account_id: &str) -> Option<ClaimedPending> {
    if !quota::business_ok(balance) {
        return None;
    }
    let data = balance.get("data").unwrap_or(&Value::Null);
    let plans = data.get("plans")?.as_array()?;
    let balances = data.get("balances").and_then(|b| b.as_array());

    // 已下发的桶覆盖的 entitlement_id 集合
    let covered_eids: std::collections::HashSet<&str> = balances
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("entitlement_id").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();

    // 找第一条「active 且权益尚未生效（无桶行）」的套餐；
    // 用 server_time 做时钟基准，防本机偏差把刚生效的判成待生效
    let now = data
        .get("server_time")
        .and_then(|t| t.as_i64())
        .unwrap_or(0);
    for pl in plans {
        let active = pl
            .get("status")
            .and_then(|s| s.as_str())
            .map(|s| s.eq_ignore_ascii_case("active"))
            .unwrap_or(false);
        if !active {
            continue;
        }
        let ents = pl.get("entitlements").and_then(|e| e.as_array())?;
        let pending_ents: Vec<&Value> = ents
            .iter()
            .filter(|e| {
                let eid = e.get("entitlement_id").and_then(Value::as_str).unwrap_or("");
                eid.is_empty() || !covered_eids.contains(eid)
            })
            .collect();
        if pending_ents.is_empty() {
            continue; // 权益全部已进桶 → 已生效，不算待生效
        }
        // 生效时刻取值分两级：
        // - 权威：entitlements[].effective_at（秒级；0 = 立即生效）。已过而桶仍缺 =
        //   服务端数据未落，跳过该套餐（桶随时会出现，展示待生效反而是错）。
        // - 预估：权威字段缺失时回落套餐 starts_at——它是活动开始时间不是生效时间，
        //   只作展示参考；且不参与「已过即跳过」判定（starts_at 必然已过，会把这个
        //   窗口里的待生效态整个跳没了）。前端对无 effectiveAt 的条目显示预估文案。
        let authoritative_eff = pending_ents
            .iter()
            .filter_map(|e| {
                e.get("effective_at")
                    .or_else(|| e.get("effectiveAt"))
                    .and_then(|x| x.as_i64())
            })
            .min();
        if let Some(eff) = authoritative_eff {
            // 0 = 立即生效：等价于「生效时刻已到」，桶仍缺就是服务端数据未落，
            // 与「已过而桶缺」同因，一并跳过不展示（桶随时会出现）
            if eff == 0 || (now > 0 && eff <= now) {
                continue;
            }
        }
        // 走到这里 authoritative_eff 必为 Some(>0)（0/已过已跳过）；
        // None 时展示值回落 starts_at（预估），starts_at 也缺则不显示时间
        let display_eff = authoritative_eff
            .or_else(|| pl.get("starts_at").and_then(|x| x.as_i64()))
            .filter(|s| *s != 0);
        let ends_at = pl.get("ends_at").and_then(|x| x.as_i64());
        let name = pl
            .get("name")
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| {
                pl.get("plan_id")
                    .and_then(|s| s.as_str())
                    .unwrap_or("unknown")
                    .to_string()
            });
        return Some(ClaimedPending {
            account_id: account_id.to_string(),
            plan_name: name,
            effective_at: display_eff.map(|s| if s == 0 { 0 } else { s * 1000 }),
            ends_at: ends_at.map(|s| s * 1000),
            // 权威字段缺失 → 预估（前端文案标注「据活动说明」）
            source: if authoritative_eff.is_some() { "balance" } else { "balance-estimate" }.into(),
        });
    }
    None
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
        .map_err(|e| {
            let msg = http_err(&crate::i18n::tr("err.claim.touch_req"), e);
            // 诊断摘要行：touch 拉取失败（429/3012 前哨/网络错）写 flowlog，
            // 系统日志页可追溯「显示可领却领不了」「刷不出投放」类问题
            crate::flowlog::log("claim", "touch-fail", &msg.split('\n').next().unwrap_or("").chars().take(120).collect::<String>());
            msg
        })?
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
                    effective_at: None,
                    campaign_id: dl_campaign.clone(),
                });
            }
        }
    }
    // 诊断摘要行：touch 拉取成功——投放条数、可领 plan_id 清单、响应体截 2K
    // （可领资格的直接证据；「别人能刷出我刷不出」的两端对比数据源）
    {
        let pids: Vec<&str> = out.iter().map(|p| p.plan_id.as_str()).collect();
        let clip = |s: &str, cap: usize| if s.chars().count() <= cap { s.to_string() } else { format!("{}…[共 {} 字符]", s.chars().take(cap).collect::<String>(), s.chars().count()) };
        crate::flowlog::log(
            "claim",
            "touch-ok",
            &format!(
                "deliveries={} plans={} resp={}",
                dels.len(),
                pids.join(","),
                clip(&v.to_string(), 2048)
            ),
        );
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
        .map_err(|e| {
            // 官方客户端语义（asar 实锤 tc()/Yde()）：全部响应 body 均为 JSON——
            // 含 405+3012 拒绝（{"code":3012,"msg":...}）与 HTTP 429。错误分支
            // 两条轨并行：http_status（HTTP 层）+ biz_code（body 的 code 字段），
            // 前端退避按这两轨分流，不猜字符串
            let (status, body) = match e {
                ureq::Error::Status(code, r) => (i64::from(code), r.into_string().unwrap_or_default()),
                _ => (0, String::new()),
            };
            let biz = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("code").and_then(|c| c.as_i64()))
                .unwrap_or(-1);
            // 消息构造对齐官方 Yde()：body JSON 的 error/message/msg/detail 字段
            // 优先，WAF HTML 页（官方 wX 同款判据）回退 "HTTP {status}"
            let msg = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| ["error", "message", "msg", "detail"]
                    .iter()
                    .find_map(|k| v.get(k).and_then(|x| x.as_str()).map(String::from)))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("HTTP {status}"));
            ClaimError {
                code: -1,
                message: format!("{}: {msg}", crate::i18n::tr("err.claim.claim_req")),
                next_at: None,
                http_status: status,
                biz_code: biz,
            }
        })?
        .into_string()
        .map_err(|e| ClaimError {
            code: -1,
            message: crate::i18n::trf("err.http.read", &[("e", &e.to_string())]),
            next_at: None,
            http_status: 0,
            biz_code: -1,
        })?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp.clone()));
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    // 诊断摘要行：claim 提交的请求体（{plan_id}，无敏感内容全记）与响应体截 2K
    crate::flowlog::log(
        "claim",
        if code == 0 { "claim-http-ok" } else { "claim-http-err" },
        &format!("POST billing/claim req={{\"plan_id\":\"{plan_id}\"}} code={code} resp={}", {
            let clip = |s: &str, cap: usize| if s.chars().count() <= cap { s.to_string() } else { format!("{}…[共 {} 字符]", s.chars().take(cap).collect::<String>(), s.chars().count()) };
            clip(&resp, 2048)
        }),
    );
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
                    // effective_at 0 = 立即生效（占位语义），按原值保留给上层判断；
                    // 响应没给该字段时为 None，前端走「据活动说明」兜底
                    effective_at: num_field(e, "effective_at", "effectiveAt")
                        .map(|n| n as i64),
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
    // 可领条生效时刻：entitlements 里最早的 effective_at（秒 → 毫秒）。
    // 全部缺失 → None；存在 0 值 → Some(0)（立即生效优先于任何未来时刻）
    let effective_at = {
        let vals: Vec<i64> = grant_items.iter().filter_map(|g| g.effective_at).collect();
        if vals.is_empty() {
            None
        } else {
            let min = vals.iter().min().copied().unwrap_or(0);
            Some(if min == 0 { 0i64 } else { min * 1000 })
        }
    };
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
        effective_at,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 文档 §3 实测形状：active 套餐 + entitlements 有桶行覆盖 → 已生效，非待生效
    #[test]
    fn pending_none_when_bucket_covered() {
        let resp = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1794010672,
                "plans": [{
                    "plan_id": "zcode-v3-start-plan-1106-wk",
                    "name": "ZCODE WEEKEND BUILD",
                    "status": "active",
                    "starts_at": 1793964222, "ends_at": 1794186000,
                    "entitlements": [{
                        "entitlement_id": "ent-1",
                        "show_name": "GLM-5.3-Flash", "meter": "model_usage",
                        "unit_type": "token", "grant_units": 500000000u64,
                        "period": "one_time", "effective_at": 1793977200
                    }]
                }],
                "balances": [{
                    "bucket_id": "b1", "plan_id": "zcode-v3-start-plan-1106-wk",
                    "entitlement_id": "ent-1", "show_name": "GLM-5.3-Flash",
                    "total_units": 500000000u64, "remaining_units": 500000000u64
                }]
            }
        });
        assert!(claimed_pending_from_balance(&resp, "a1").is_none(), "桶已覆盖不应判待生效");
    }

    /// 待生效核心场景：active 且桶未下发，effective_at 在未来 → 待生效（balance 权威源）
    #[test]
    fn pending_when_entitlement_not_yet_in_bucket() {
        let resp = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1794000000,
                "plans": [{
                    "plan_id": "wk-2", "name": "ZCODE WEEKEND BUILD",
                    "status": "active",
                    "starts_at": 1793964222, "ends_at": 1794186000,
                    "entitlements": [{
                        "entitlement_id": "ent-9",
                        "show_name": "GLM-5.3-Flash", "meter": "model_usage",
                        "unit_type": "token", "grant_units": 500000000u64,
                        "period": "one_time", "effective_at": 1794077200
                    }]
                }],
                "balances": []
            }
        });
        let p = claimed_pending_from_balance(&resp, "a1").expect("应判定待生效");
        assert_eq!(p.plan_name, "ZCODE WEEKEND BUILD");
        assert_eq!(p.effective_at, Some(1794077200 * 1000), "秒→毫秒换算");
        assert_eq!(p.ends_at, Some(1794186000 * 1000));
        assert_eq!(p.source, "balance", "权威字段存在 → balance 源");
    }

    /// 回归钉：starts_at 必然已过（活动放量时刻），无 effective_at 时不得因
    /// 「已过即跳过」把待生效态整个跳没——只降级为预估展示
    #[test]
    fn pending_kept_without_effective_at_even_if_starts_at_past() {
        let resp = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1794000000,
                "plans": [{
                    "plan_id": "wk-3", "name": "PLAN X",
                    "status": "active",
                    "starts_at": 1793964222, "ends_at": 1794186000,
                    "entitlements": [{
                        "entitlement_id": "ent-10",
                        "show_name": "GLM-5.3-Flash", "meter": "model_usage",
                        "unit_type": "token", "grant_units": 100u64,
                        "period": "one_time"
                    }]
                }],
                "balances": []
            }
        });
        let p = claimed_pending_from_balance(&resp, "a1").expect("starts_at 已过不得跳过待生效判定");
        assert_eq!(p.source, "balance-estimate", "无权威字段 → 预估源");
        assert_eq!(p.effective_at, Some(1793964222 * 1000), "展示值回落 starts_at");
    }

    /// effective_at = 0（立即生效）而桶仍缺：服务端数据未落，跳过不展示
    #[test]
    fn pending_skipped_when_effective_now_but_bucket_missing() {
        let resp = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1794000000,
                "plans": [{
                    "plan_id": "wk-4", "name": "PLAN Y",
                    "status": "active",
                    "entitlements": [{
                        "entitlement_id": "ent-11",
                        "show_name": "GLM-5.3-Flash", "meter": "model_usage",
                        "unit_type": "token", "grant_units": 100u64,
                        "period": "one_time", "effective_at": 0
                    }]
                }],
                "balances": []
            }
        });
        assert!(claimed_pending_from_balance(&resp, "a1").is_none(), "立即生效+桶缺=数据未落，不展示");
    }

    /// 非 active 套餐（如已过期）不参与判定；business_ok 不过直接 None
    #[test]
    fn pending_none_for_inactive_plan_or_bad_code() {
        let inactive = json!({
            "code": 0, "msg": "", "data": {
                "server_time": 1794000000,
                "plans": [{
                    "plan_id": "old", "name": "OLD", "status": "expired",
                    "entitlements": [{
                        "entitlement_id": "ent-12", "show_name": "X",
                        "unit_type": "token", "grant_units": 1u64, "period": "one_time"
                    }]
                }],
                "balances": []
            }
        });
        assert!(claimed_pending_from_balance(&inactive, "a1").is_none(), "非 active 不判定");
        let bad = json!({ "code": 401, "msg": "auth", "data": null });
        assert!(claimed_pending_from_balance(&bad, "a1").is_none(), "business_ok 不过 → None");
    }
}
