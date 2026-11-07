
use crate::claim::claim_token;
use crate::quota;
use crate::zcrypto;
use serde_json::Value;
use std::path::Path;

// 绑定端点是奖励中心 web（zcode.z.ai/cn/rewards）的同源代理前缀 /zcode-api/，
// 与 /api/v1/ 不是同一路由——实测 /api/v1 下无 bind-code
pub const REFERRAL_SUMMARY_URL: &str = "https://zcode.z.ai/api/v1/incentive/referral/summary";
pub const REFERRAL_INVITEES_URL: &str = "https://zcode.z.ai/api/v1/incentive/referral/invitees";
pub const REFERRAL_BIND_URL: &str = "https://zcode.z.ai/zcode-api/incentive/referral/bind-code";

const REFERRAL_TIMEOUT_SECS: u64 = 20;

fn agent() -> ureq::Agent {
    // 统一记录层：referral 链（summary/invitees/bind）经 httplog 共享 Agent，
    // 中间件自动落 flowlog，系统日志页可查
    crate::httplog::logged_agent(REFERRAL_TIMEOUT_SECS)
}

fn get_json(url: &str, token: &str, mid: Option<String>) -> Result<Value, String> {
    let mut req = agent().get(url);
    for (k, v) in quota::zai_billing_headers_with_mid(token, mid) {
        req = req.set(&k, &v);
    }
    let resp = req
        .call()
        .map_err(|e| crate::claim::http_err(&crate::i18n::tr("err.referral.req"), e))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Err(crate::claim::failure_message(code, &v));
    }
    Ok(v)
}

pub fn summary(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    device_mid: Option<String>,
) -> Result<Value, String> {
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    get_json(REFERRAL_SUMMARY_URL, &token, device_mid)
}

pub fn invitees(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    device_mid: Option<String>,
) -> Result<Value, String> {
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    get_json(REFERRAL_INVITEES_URL, &token, device_mid)
}

/// 受邀号绑码。captcha_param 由验证码子窗口产出（与 claim 同一条无痕/交互流程），
/// 服务端对缺票据请求的行为未验证过，按 claim 同样硬前置处理
pub fn submit_bind(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    invite_code: &str,
    captcha_param: &str,
    captcha_region: Option<&str>,
    device_mid: Option<String>,
) -> Result<Value, String> {
    if captcha_param.trim().is_empty() {
        return Err(crate::i18n::tr("err.claim.no_captcha").into());
    }
    let code = invite_code.trim().to_uppercase();
    if code.is_empty() {
        return Err(crate::i18n::tr("err.referral.no_code").into());
    }
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    let mut req = agent().post(REFERRAL_BIND_URL);
    for (k, v) in quota::zai_billing_headers_with_mid(&token, device_mid) {
        req = req.set(&k, &v);
    }
    req = req.set("X-Aliyun-Captcha-Verify-Param", captcha_param.trim());
    if let Some(r) = captcha_region.filter(|r| !r.trim().is_empty()) {
        req = req.set("X-Aliyun-Captcha-Verify-Region", r.trim());
    }
    let resp = req
        .send_json(serde_json::json!({ "invite_code": code }))
        .map_err(|e| crate::claim::http_err(&crate::i18n::tr("err.referral.req"), e))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    let biz = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if biz != 0 {
        return Err(crate::claim::failure_message(biz, &v));
    }
    if v.pointer("/data/bound") != Some(&Value::Bool(true)) {
        return Err(crate::i18n::tr("err.referral.not_bound").into());
    }
    Ok(v)
}
