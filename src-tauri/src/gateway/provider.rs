// GATEWAY 供应商页动作：获取模型 / 右键测试（magpie 式供应商管理）。
// 测试请求完全绕开池轮转/熔断/冷却——独立直连，测完不留任何状态，
// 不给账号添风控暴露（一次右键一条请求，不做批量探活）
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use super::{config, pool, upstream};

fn find_provider(provider_id: &str) -> Option<config::ProviderConfig> {
    config::GatewayConfig::load()
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
}

fn err_body(body: &str) -> String {
    body.chars().take(120).collect::<String>()
}

// 测试结果的错误体要在弹窗里全文可读，不能复用 fetch_models 那条塞进 toast 的 120 字截断；
// 仍留 4K 上限挡住上游异常返回整页 HTML 这类极端情况
fn test_err_body(body: &str) -> String {
    body.chars().take(4096).collect::<String>()
}

/// 获取模型：有 key 的供应商拉 /v1/models（OpenAI 兼容，data[].id）；
/// 无 key 的默认上游（zcode）无公开 models 端点，直接回缓存清单
pub async fn fetch_models(provider_id: &str) -> Result<Value, String> {
    let prov = find_provider(provider_id)
        .ok_or_else(|| crate::i18n::tr("err.provider.missing"))?;
    if prov.api_key.trim().is_empty() {
        return Ok(json!({ "models": prov.models, "cached": true }));
    }
    let url = format!("{}/v1/models", prov.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .bearer_auth(prov.api_key.trim())
        .send()
        .await
        .map_err(|e| crate::i18n::trf("err.provider.net", &[("e", &e.to_string())]))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(crate::i18n::trf(
            "err.provider.http",
            &[("s", &status.to_string()), ("b", &err_body(&body))],
        ));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let models: Vec<String> = v
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    persist_models(provider_id, &models);
    Ok(json!({ "models": models, "cached": false }))
}

/// 模型缓存落盘：config 只在 UI 保存时写，这里读改写单字段，覆盖窗口极小可接受
fn persist_models(provider_id: &str, models: &[String]) {
    let mut cfg = config::GatewayConfig::load();
    if let Some(p) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        p.models = models.to_vec();
        if let Err(e) = cfg.save() {
            eprintln!("[provider] 模型缓存落盘失败: {e}");
        }
    }
}

/// 模型测试：tiny 请求（8 token / 单条 "hi"），返回 {ok, status, ms, error, model}。
/// zcode 上游：账号池 token 直打 messages（钉 3.16.3 头族），可指定账号单测；
/// 通用上游：openai 兼容 chat/completions + api_key。model 由调用方指定（右键
/// 某个模型 chip 时传入），未指定时回落到清单首个 / 内置默认。
pub async fn test_provider(
    provider_id: &str,
    account_id: Option<String>,
    model: Option<&str>,
) -> Result<Value, String> {
    let prov = find_provider(provider_id)
        .ok_or_else(|| crate::i18n::tr("err.provider.missing"))?;
    let is_zcode = prov.id == "zcode" || prov.base_url.contains("zcode.z.ai");
    if !is_zcode && prov.api_key.trim().is_empty() {
        return Err(crate::i18n::tr("err.provider.no_key"));
    }
    let started = Instant::now();
    let (url, headers, body, model, account) = if is_zcode {
        let members = pool::members().unwrap_or_default();
        let member = match account_id.as_deref() {
            Some(id) if !id.is_empty() => members.iter().find(|m| m.id == id),
            _ => members.first(),
        };
        let picked = model.map(str::to_string)
            .unwrap_or_else(|| "GLM-5.3-Flash".to_string());
        let Some(m) = member else {
            return Ok(json!({
                "ok": false, "status": Value::Null, "ms": started.elapsed().as_millis() as u64,
                "error": crate::i18n::tr("err.provider.no_account"),
                "model": picked, "account": Value::Null,
            }));
        };
        (
            upstream::UPSTREAM_MESSAGES.to_string(),
            upstream::headers(&m.token, m.mid.as_deref()),
            json!({
                "model": picked, "max_tokens": 8, "stream": false,
                "messages": [{ "role": "user", "content": "hi" }]
            }),
            picked,
            json!(m.name),
        )
    } else {
        let picked = model.map(str::to_string)
            .or_else(|| prov.models.first().cloned())
            .unwrap_or_else(|| "gpt-4o-mini".into());
        (
            format!("{}/v1/chat/completions", prov.base_url.trim_end_matches('/')),
            vec![
                ("Authorization".to_string(), format!("Bearer {}", prov.api_key.trim())),
                ("Content-Type".to_string(), "application/json".to_string()),
            ],
            json!({
                "model": picked, "max_tokens": 8, "stream": false,
                "messages": [{ "role": "user", "content": "hi" }]
            }),
            picked,
            Value::Null,
        )
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let resp = req.json(&body).send().await;
    let ms = started.elapsed().as_millis() as u64;
    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let text = r.text().await.unwrap_or_default();
            Ok(json!({
                "ok": status == 200,
                "status": status,
                "ms": ms,
                "error": if status == 200 { Value::Null } else { json!(test_err_body(&text)) },
                "model": model,
                "account": account,
            }))
        }
        Err(e) => Ok(json!({
            "ok": false, "status": Value::Null, "ms": ms,
            "error": e.to_string(), "model": model, "account": account,
        })),
    }
}
