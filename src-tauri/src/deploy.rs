
use crate::i18n::tr;
use crate::quota::{self, Channel};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeployOutcome {
    Entitled { entitlements: usize, models: Vec<String> },
    NoEntitlement,
    AuthFailed,
}

#[derive(Debug, Clone, PartialEq)]
enum DeployErr {
    Auth,
    Other(String),
}

type DeployFetch<'a> = dyn Fn(&str, &str) -> Result<Value, DeployErr> + 'a;

pub(crate) fn verify_switch(
    creds: &Value,
    config: Option<&Value>,
    secret: &str,
    mid: Option<String>,
    new_gen: bool,
    account_id: &str,
) -> Option<DeployOutcome> {
    let channels = quota::pick_channels(creds, config, secret, new_gen);
    classify_via(&channels, &|url, token| real_fetch(url, token, mid.as_deref(), account_id))
}

pub(crate) fn verify_message(outcome: &DeployOutcome) -> String {
    match outcome {
        DeployOutcome::Entitled { .. } => String::new(),
        DeployOutcome::NoEntitlement => tr("deploy.no_entitlement"),
        DeployOutcome::AuthFailed => tr("deploy.auth_failed"),
    }
}

fn balance_entitlements(balance: &Value) -> Option<usize> {
    let data = balance.get("data").unwrap_or(balance);
    let data = data.as_object()?;
    let balances = data.get("balances").and_then(|b| b.as_array());
    let plans = data.get("plans").and_then(|p| p.as_array());
    if balances.is_none() && plans.is_none() {
        return None;
    }
    let n = balances
        .map(|a| a.len())
        .filter(|n| *n > 0)
        .or_else(|| {
            plans.map(|arr| {
                arr.iter()
                    .filter(|pl| {
                        pl.get("status")
                            .and_then(|s| s.as_str())
                            .map(|s| s.eq_ignore_ascii_case("active"))
                            .unwrap_or(false)
                    })
                    .count()
            })
        })?;
    Some(n)
}

fn balance_models(balance: &Value) -> Option<Vec<String>> {
    let data = balance.get("data").unwrap_or(balance);
    let arr = data.as_object()?.get("balances")?.as_array()?;
    let mut out: Vec<String> = vec![];
    for b in arr {
        let mut got: Vec<String> = vec![];
        if let Some(cs) = b.get("capabilities").and_then(|c| c.as_array()) {
            for c in cs.iter().filter_map(|c| c.as_str()) {
                let t = c.trim();
                if t.to_lowercase().starts_with("model:") {
                    let id = t["model:".len()..].trim();
                    if !id.is_empty() {
                        got.push(id.to_string());
                    }
                }
            }
        }
        if got.is_empty() {
            if let Some(n) = b
                .get("show_name")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
            {
                got.push(n.to_string());
            }
        }
        for m in got {
            let m = quota::canonical_model_id(&m);
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    Some(out)
}

fn has_active_subscription(sub: &Value) -> bool {
    let arr = match sub.get("data").and_then(|d| d.as_array()) {
        Some(a) => a,
        None => match sub.as_array() {
            Some(a) => a,
            None => return false,
        },
    };
    arr.iter().any(quota::is_active_coding_plan_entry)
}

fn biz_code(v: &Value) -> Option<i64> {
    v.get("code").and_then(|c| c.as_i64())
}

fn envelope_msg(v: &Value) -> &str {
    ["msg", "message", "error"]
        .iter()
        .find_map(|k| v.get(k).and_then(|x| x.as_str()))
        .unwrap_or("")
}

enum Verdict {
    Entitled(usize, Vec<String>),
    Empty,
    Auth,
    Inconclusive,
}

fn monitor_verdict(v: Result<Value, DeployErr>) -> Verdict {
    match v {
        Ok(v) if v.is_object() && quota::business_ok(&v) => {
            if has_active_subscription(&v) {
                Verdict::Entitled(1, vec![])
            } else {
                Verdict::Empty
            }
        }
        Ok(v) => {
            if quota::is_no_plan_message(envelope_msg(&v)) {
                Verdict::Empty
            } else if let Some(code) = biz_code(&v) {
                match quota::classify_biz_err(code) {
                    quota::BizErrFamily::Auth => Verdict::Auth,
                    quota::BizErrFamily::QuotaExhausted => Verdict::Empty,
                    _ => Verdict::Inconclusive,
                }
            } else {
                Verdict::Inconclusive
            }
        }
        Err(DeployErr::Auth) => Verdict::Auth,
        Err(DeployErr::Other(_)) => Verdict::Inconclusive,
    }
}

fn billing_verdict(v: Result<Value, DeployErr>) -> Verdict {
    match v {
        Ok(v) if v.is_object() && quota::business_ok(&v) => match balance_entitlements(&v) {
            Some(n) if n > 0 => Verdict::Entitled(n, balance_models(&v).unwrap_or_default()),
            Some(_) => Verdict::Empty,
            None => Verdict::Inconclusive,
        },
        Ok(v) => {
            match biz_code(&v).map(quota::classify_biz_err) {
                Some(quota::BizErrFamily::Auth) => Verdict::Auth,
                Some(quota::BizErrFamily::QuotaExhausted) => Verdict::Empty,
                _ => Verdict::Inconclusive,
            }
        }
        Err(DeployErr::Auth) => Verdict::Auth,
        Err(DeployErr::Other(_)) => Verdict::Inconclusive,
    }
}

fn classify_via(channels: &[Channel], fetch: &DeployFetch) -> Option<DeployOutcome> {
    if channels.is_empty() {
        return None;
    }
    let mut entitled = 0usize;
    let mut models: Vec<String> = vec![];
    let mut definite_empty = false;
    let mut auth_failed = false;
    let mut definite_channels = 0usize;
    for ch in channels {
        let verdict = match ch {
            Channel::Monitor(key) => monitor_verdict(fetch(&quota::SUBSCRIPTION_URL, key)),
            Channel::ZaiBilling(tok) => {
                let url = format!("{}?app_version={}", quota::BILLING_BALANCE_URL, quota::zcode_app_version());
                billing_verdict(fetch(&url, tok))
            }
        };
        match verdict {
            Verdict::Entitled(n, ms) => {
                entitled += n;
                for m in ms {
                    if !models.contains(&m) {
                        models.push(m);
                    }
                }
                definite_channels += 1;
            }
            Verdict::Empty => {
                definite_empty = true;
                definite_channels += 1;
            }
            Verdict::Auth => {
                auth_failed = true;
                definite_channels += 1;
            }
            Verdict::Inconclusive => {}
        }
    }
    if entitled > 0 {
        return Some(DeployOutcome::Entitled { entitlements: entitled, models });
    }
    if definite_channels == channels.len() && definite_empty && !auth_failed {
        return Some(DeployOutcome::NoEntitlement);
    }
    if auth_failed {
        return Some(DeployOutcome::AuthFailed);
    }
    None
}

fn real_fetch(url: &str, token: &str, mid: Option<&str>, account_id: &str) -> Result<Value, DeployErr> {
    // 统一记录层：切换校验（低频、诊断价值高——登录态验证失败可追溯）经 httplog；
    // 应用级代理池 scope=deploy：出口按账号粘性（池关/未配置 → 直连，行为与改造前一致）
    let agent = crate::claim::app_proxy_agent("deploy", account_id, 8)
        .map(|a| a)
        .unwrap_or_else(|| crate::httplog::logged_agent(8));
    let mut req = agent.get(url);
    if url.contains("zcode.z.ai") {
        for (k, v) in quota::zai_billing_headers_with_mid(token, mid.map(str::to_string)) {
            req = req.header(&k, &v);
        }
    } else {
        req = req
            .header("Authorization", &format!("Bearer {token}"))
            .header("User-Agent", &format!("ZCode/{}", quota::zcode_app_version()))
            .header("x-request-id", &uuid::Uuid::new_v4().to_string());
    }
    let resp = req.call().map_err(|e| DeployErr::Other(e.to_string()))?;
    let (status, text) = crate::httplog::read_resp(resp).map_err(|e| DeployErr::Other(e.to_string()))?;
    if (400..600).contains(&status) {
        return Err(map_http_status(status, &text));
    }
    if text.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text.clone())))
}

// 4xx/5xx 分流（3.x http_status_as_error(false) 后 HTTP 状态在 Ok(resp) 路径）：
// 401/403 与 body 业务 401 都是登录态失效
fn map_http_status(status: u16, body: &str) -> DeployErr {
    if status == 401 || status == 403 {
        return DeployErr::Auth;
    }
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if v.get("code").and_then(|c| c.as_i64()) == Some(401) {
            return DeployErr::Auth;
        }
    }
    DeployErr::Other(format!("http {status}"))
}
