// GATEWAY 翻译层：/v1/messages（Anthropic 原生）直通转换器
// 语义对齐 ZCode2api-go translate.go：system = 白名单前缀 + 用户追加段（逐块 cache_control ephemeral）、
// max_tokens 钳制、metadata.user_id 形状照发、output_config.effort 思考档。
// 本文件只保留 Anthropic 侧（/v1/messages 与 /v1/responses）；OpenAI 转换在 openai.rs。
use serde_json::{json, Value};

/// 前缀快照（3.17.1，构建期嵌入）
pub const PREFIX_JSON: &str = include_str!("assets/prefix.json");

pub fn prefix_segs() -> Vec<String> {
    let v: Value = serde_json::from_str(PREFIX_JSON).expect("prefix.json 损坏");
    v.get("system_prefix")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 模型名映射：表内命中用映射值，否则回落 GLM-5.3-Flash
pub fn map_model(name: &str) -> String {
    match name.trim().to_lowercase().as_str() {
        "glm-5.3" => "GLM-5.3".into(),
        "glm-5.3-flash" => "GLM-5.3-Flash".into(),
        _ => "GLM-5.3-Flash".into(),
    }
}

/// /v1/messages 入站（Anthropic 原生）→ 上游 body。
/// 直通为主：model 映射、system 前缀注入、max_tokens 钳制、metadata 补齐、
/// thinking → output_config.effort。非流式请求也转 stream=true（M2 聚合）。
pub fn anthropic_to_upstream(req: &Value) -> Result<Value, String> {
    if !req.get("messages").map(|m| m.is_array()).unwrap_or(false) {
        return Err("messages array required".into());
    }

    // system：入站可为 string 或 text 块数组；抽出用户段，前缀统一注入
    let mut sys_extra: Vec<String> = vec![];
    match req.get("system") {
        Some(Value::String(s)) if !s.is_empty() => sys_extra.push(s.clone()),
        Some(Value::Array(arr)) => {
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                        if !t.is_empty() {
                            sys_extra.push(t.to_string());
                        }
                    }
                }
            }
        }
        _ => {}
    }

    // 官方 body 逐个 system 块都带 cache_control ephemeral（plan-08 §4），形状照发
    let mut system: Vec<Value> = prefix_segs()
        .into_iter()
        .map(|t| json!({ "type": "text", "text": t, "cache_control": { "type": "ephemeral" } }))
        .collect();
    if !sys_extra.is_empty() {
        system.push(json!({ "type": "text", "text": sys_extra.join("\n\n"), "cache_control": { "type": "ephemeral" } }));
    }

    // max_tokens：缺省 4096，上限 128000
    let max_tokens = match req.get("max_tokens").and_then(|v| v.as_u64()) {
        Some(n) if n > 0 => n.min(128_000),
        _ => 4096,
    };

    // thinking → output_config.effort（官方路径；disabled 语义 = 不传）
    let effort = req
        .get("thinking")
        .map(|t| {
            // Anthropic 原生形态 {"type":"enabled","budget_tokens":N} → 按预算粗分档
            match (t.get("type").and_then(|x| x.as_str()), t.get("budget_tokens").and_then(|x| x.as_u64())) {
                (Some("enabled"), Some(b)) if b >= 16_000 => "max",
                (Some("enabled"), _) => "high",
                _ => "",
            }
        })
        .unwrap_or("");

    // metadata.user_id 是内嵌 JSON 字符串（形状照发，风控不校验；Go translate.go 对齐）
    let uid = json!({
        "device_id": uuid::Uuid::new_v4().to_string(),
        "account_uuid": "",
        "session_id": "",
    }).to_string();
    let mut out = json!({
        "model": map_model(req.get("model").and_then(|m| m.as_str()).unwrap_or("")),
        "messages": req.get("messages"),
        "max_tokens": max_tokens,
        "stream": true, // 上游一律流式；非流式由 handler 聚合
        "system": system,
        "metadata": { "user_id": uid },
    });
    if !effort.is_empty() {
        out["output_config"] = json!({ "effort": effort });
    }
    if let Some(t) = req.get("temperature").filter(|v| v.is_number()) {
        out["temperature"] = t.clone();
    }
    if let Some(p) = req.get("top_p").filter(|v| v.is_number()) {
        out["top_p"] = p.clone();
    }
    if let Some(stops) = req.get("stop_sequences").filter(|v| v.is_array()) {
        out["stop_sequences"] = stops.clone();
    }
    // tools / tool_choice 原样透传（上游同为 anthropic 形态）
    if let Some(tools) = req.get("tools").filter(|v| v.is_array() && !v.as_array().unwrap().is_empty()) {
        out["tools"] = tools.clone();
    }
    if let Some(tc) = req.get("tool_choice") {
        if tc.is_object() || tc.as_str() == Some("auto") || tc.as_str() == Some("any") {
            out["tool_choice"] = tc.clone();
        }
        // "none" 不发：上游收到会空响应（Go 版实测）
    }
    Ok(out)
}

/// 从上游 SSE 全文聚合出非流式响应（M2：收到 message_stop / 上游断开即止）。
/// 事件形态：event: content_block_delta / data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
pub fn aggregate_sse(raw: &str, model: &str) -> Value {
    let mut text = String::new();
    let mut thinking = String::new();
    let mut stop_reason: Option<String> = None;
    let mut usage_in: i64 = 0;
    let mut usage_out: i64 = 0;
    let mut usage_cr: i64 = 0;
    let mut usage_cw: i64 = 0;
    let mut id = String::new();

    for line in raw.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(d) => d.trim(),
            None => continue,
        };
        let ev: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match ev.get("type").and_then(|t| t.as_str()) {
            Some("message_start") => {
                id = ev
                    .pointer("/message/id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                usage_in = ev
                    .pointer("/message/usage/input_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                usage_cr = ev
                    .pointer("/message/usage/cache_read_input_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                usage_cw = ev
                    .pointer("/message/usage/cache_creation_input_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
            }
            Some("content_block_delta") => {
                let dt = ev.pointer("/delta/type").and_then(|x| x.as_str()).unwrap_or("");
                if dt == "text_delta" {
                    if let Some(t) = ev.pointer("/delta/text").and_then(|x| x.as_str()) {
                        text.push_str(t);
                    }
                } else if dt == "thinking_delta" {
                    // 上游默认（无 output_config）也带思考块；max_tokens 吃满时 text 可能空
                    if let Some(t) = ev.pointer("/delta/thinking").and_then(|x| x.as_str()) {
                        thinking.push_str(t);
                    }
                }
            }
            Some("message_delta") => {
                stop_reason = ev
                    .pointer("/delta/stop_reason")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                if let Some(u) = ev.pointer("/usage/output_tokens").and_then(|x| x.as_i64()) {
                    usage_out = u;
                }
            }
            Some("message_stop") => break,
            _ => {}
        }
    }

    json!({
        "id": if id.is_empty() { format!("msg_{}", uuid::Uuid::new_v4().simple()) } else { id },
        "type": "message",
        "role": "assistant",
        "model": model,
        // max_tokens 被思考耗尽时 text 为空，回退给出思考预览（附说明），避免消费端拿到空消息
        "content": if text.is_empty() && !thinking.is_empty() {
            json!([{ "type": "text", "text": format!("[思考耗尽 max_tokens] {}", &thinking.chars().take(400).collect::<String>()) }])
        } else {
            json!([{ "type": "text", "text": text }])
        },
        "stop_reason": stop_reason.unwrap_or_else(|| "end_turn".into()),
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": usage_in, "output_tokens": usage_out,
            "cache_read_input_tokens": usage_cr,
            "cache_creation_input_tokens": usage_cw,
        },
    })
}

/// anthropic 原生形态聚合（/v1/responses 的 text/usage 提取复用此结构）
pub fn aggregate_sse_to_anthropic(raw: &str, model: &str) -> Value {
    aggregate_sse(raw, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_passes_cache_usage_through() {
        let sse = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":9,\"cache_read_input_tokens\":7,\"cache_creation_input_tokens\":3}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
        );
        let out = aggregate_sse(sse, "GLM-5.3-Flash");
        assert_eq!(out["usage"]["input_tokens"], 9);
        assert_eq!(out["usage"]["output_tokens"], 2);
        assert_eq!(out["usage"]["cache_read_input_tokens"], 7);
        assert_eq!(out["usage"]["cache_creation_input_tokens"], 3);
    }
}