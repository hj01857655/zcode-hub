// TWOAPI 翻译层：OpenAI Responses API ⇄ Anthropic messages（M4/M5）
// 语义对齐 ZCode2api-go internal/server/responses.go：instructions/text.format→system 追加段、
// input 字符串或 item 数组（function_call/function_call_output 双向）、tools 内置类型跳过。
// M5：流式装配器（response.created → output_text.delta → output_item.done → response.completed）。
use std::collections::HashMap;

use serde_json::{json, Value};

use super::openai::{translate_sse_line, Delta};
use super::translate::{map_model, prefix_segs, runtime_system_extra};

/// Responses 入站请求的宽松视图
fn get_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

/// Responses content 块数组 → 纯文本（兼容 string）
fn flatten_content(raw: Option<&Value>) -> String {
    match raw {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Responses 请求 → anthropic 上游 body
pub fn responses_to_upstream(req: &Value) -> Result<Value, String> {
    let mut sys_extra: Vec<String> = vec![];
    if let Some(ins) = get_str(req, "instructions").map(str::trim).filter(|s| !s.is_empty()) {
        sys_extra.push(ins.to_string());
    }
    // text.format → 提示词约束（Anthropic 上游无原生 structured output）
    if let Some(fmt) = req.pointer("/text/format") {
        match get_str(fmt, "type") {
            Some("json_schema") => {
                let mut hint = "必须只输出符合以下 JSON Schema 的 JSON 对象，不要输出任何解释、markdown 代码块或多余文字：\n".to_string();
                if let Some(schema) = fmt.get("schema") {
                    hint += &schema.to_string();
                }
                sys_extra.push(hint);
            }
            Some("json_object") => sys_extra.push("必须只输出一个 JSON 对象，不要输出任何解释或 markdown 代码块。".into()),
            _ => {}
        }
    }

    let mut msgs: Vec<Value> = vec![];
    match req.get("input") {
        // 字符串：单条 user
        Some(Value::String(s)) if !s.trim().is_empty() => {
            msgs.push(json!({ "role": "user", "content": s }));
        }
        Some(Value::Array(items)) => {
            for it in items {
                let it_type = get_str(it, "type").unwrap_or("");
                let role = get_str(it, "role").unwrap_or("user");
                match it_type {
                    // assistant 侧发起的工具调用 → tool_use 块
                    "function_call" => {
                        let input = match get_str(it, "arguments") {
                            Some(a) if !a.is_empty() => serde_json::from_str::<Value>(a)
                                .unwrap_or_else(|_| json!({ "_raw": a })),
                            _ => json!({}),
                        };
                        let id = get_str(it, "call_id")
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("call_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
                        msgs.push(json!({
                            "role": "assistant",
                            "content": [{ "type": "tool_use", "id": id,
                                "name": get_str(it, "name").unwrap_or(""), "input": input }],
                        }));
                        continue;
                    }
                    // 客户端回传的工具结果 → user tool_result 块
                    "function_call_output" => {
                        let out_text = flatten_content(it.get("output"));
                        let out_text = if out_text.is_empty() {
                            it.get("output").map(|v| v.to_string()).unwrap_or_default()
                        } else {
                            out_text
                        };
                        msgs.push(json!({
                            "role": "user",
                            "content": [{ "type": "tool_result",
                                "tool_use_id": get_str(it, "call_id").unwrap_or(""), "content": out_text }],
                        }));
                        continue;
                    }
                    _ => {}
                }
                let text = flatten_content(it.get("content"));
                match role {
                    "system" | "developer" => {
                        if !text.is_empty() {
                            sys_extra.push(text);
                        }
                    }
                    "assistant" => {
                        if !text.is_empty() {
                            msgs.push(json!({ "role": "assistant", "content": text }));
                        }
                    }
                    _ => {
                        if !text.is_empty() {
                            msgs.push(json!({ "role": "user", "content": text }));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    if msgs.is_empty() {
        msgs.push(json!({ "role": "user", "content": "" }));
    }

    let mut system: Vec<Value> = prefix_segs()
        .into_iter()
        .map(|t| json!({ "type": "text", "text": t }))
        .collect();
    if !sys_extra.is_empty() {
        system.push(json!({ "type": "text", "text": sys_extra.join("\n\n") }));
    }
    // 运行时注入段在 instructions 用户段之后（末尾 = 最新指令位）；
    // 无 cache_control，与本通道形状一致（Go responses.go 对齐）
    for seg in runtime_system_extra() {
        system.push(json!({ "type": "text", "text": seg }));
    }

    let max_tokens = match req.get("max_output_tokens").and_then(|v| v.as_u64()) {
        Some(n) if n > 0 => n.min(128_000),
        _ => 4096,
    };
    let effort = req
        .pointer("/reasoning/effort")
        .and_then(|x| x.as_str())
        .filter(|e| matches!(*e, "low" | "high" | "max"))
        .unwrap_or("");

    let uid = json!({
        "device_id": uuid::Uuid::new_v4().to_string(),
        "account_uuid": "",
        "session_id": "",
    })
    .to_string();

    let mut out = json!({
        "model": map_model(get_str(req, "model").unwrap_or("")),
        "messages": msgs,
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
    // tools：Responses 的 {type:"function",name,description,parameters} → anthropic；
    // 内置工具（web_search 等）上游不支持，跳过
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()).filter(|t| !t.is_empty()) {
        let conv: Vec<Value> = tools
            .iter()
            .filter_map(|t| {
                let typ = get_str(t, "type").unwrap_or("");
                if !typ.is_empty() && typ != "function" {
                    return None;
                }
                let mut name = get_str(t, "name").unwrap_or("").to_string();
                let mut desc = get_str(t, "description").unwrap_or("").to_string();
                let mut params = t.get("parameters").cloned();
                if name.is_empty() {
                    if let Some(f) = t.get("function") {
                        name = get_str(f, "name").unwrap_or("").to_string();
                        desc = get_str(f, "description").unwrap_or("").to_string();
                        params = f.get("parameters").cloned();
                    }
                }
                if name.is_empty() {
                    return None;
                }
                let params = params.unwrap_or(json!({ "type": "object", "properties": {} }));
                Some(json!({ "name": name, "description": desc, "input_schema": params }))
            })
            .collect();
        if !conv.is_empty() {
            out["tools"] = json!(conv);
        }
    }
    // tool_choice 复用 chat 层映射
    if let Some(tc) = super::openai::map_tool_choice_pub(req.get("tool_choice")) {
        out["tool_choice"] = tc;
    }
    Ok(out)
}

/// 非流式聚合 → Responses response 对象
pub fn responses_object(id: &str, model: &str, text: &str, status: &str, input: i64, output: i64, cache_read: i64) -> Value {
    responses_object_with_tools(id, model, text, status, input, output, cache_read, None)
}

/// 流内 function_call 块聚合（Go server.go toolAccum 同构），含稳定的下游 item id
pub struct ToolAccum {
    order: Vec<usize>,
    calls: HashMap<usize, ToolCall>,
}

struct ToolCall {
    fc_id: String,
    call_id: String,
    name: String,
    args: String,
}

impl ToolAccum {
    fn new() -> Self {
        Self { order: Vec::new(), calls: HashMap::new() }
    }

    fn slot(&mut self, index: usize) -> &mut ToolCall {
        if !self.calls.contains_key(&index) {
            self.calls.insert(index, ToolCall {
                fc_id: format!("fc_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]),
                call_id: String::new(),
                name: String::new(),
                args: String::new(),
            });
            self.order.push(index);
        }
        self.calls.get_mut(&index).unwrap()
    }

    fn add_start(&mut self, index: usize, call_id: &str, name: &str) {
        let c = self.slot(index);
        if !call_id.is_empty() {
            c.call_id = call_id.into();
        }
        if !name.is_empty() {
            c.name = name.into();
        }
    }

    fn add_args(&mut self, index: usize, args: &str) {
        self.slot(index).args.push_str(args);
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    fn order(&self) -> &[usize] {
        &self.order
    }

    fn fc_id(&self, index: usize) -> &str {
        &self.calls[&index].fc_id
    }

    fn call(&self, index: usize) -> (&str, &str, &str, &str) {
        let c = &self.calls[&index];
        (&c.fc_id, &c.call_id, &c.name, &c.args)
    }
}

/// 响应对象组装；有工具且无文本时省略 message 项（Go responsesObjectWithTools 同构）
pub fn responses_object_with_tools(
    id: &str,
    model: &str,
    text: &str,
    status: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    tools: Option<&ToolAccum>,
) -> Value {
    let mut content: Vec<Value> = vec![];
    if !text.is_empty() {
        content.push(json!({ "type": "output_text", "text": text, "annotations": [] }));
    }
    let has_tools = tools.map(|t| !t.is_empty()).unwrap_or(false);
    let mut output_arr: Vec<Value> = vec![];
    if !text.is_empty() || !has_tools {
        output_arr.push(json!({ "id": format!("msg_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]),
                 "type": "message", "status": status, "role": "assistant", "content": content }));
    }
    if let Some(tools) = tools.filter(|t| !t.is_empty()) {
        for &idx in tools.order() {
            let (fc_id, call_id, name, args) = tools.call(idx);
            let args = if args.is_empty() { "{}" } else { args };
            output_arr.push(json!({ "id": fc_id, "type": "function_call", "status": status,
                     "call_id": call_id, "name": name, "arguments": args }));
        }
    }
    json!({
        "id": id,
        "object": "response",
        "created_at": chrono::Utc::now().timestamp(),
        "status": status,
        "model": model,
        "output": output_arr,
        "usage": {
            "input_tokens": input, "output_tokens": output, "total_tokens": input + output,
            "input_tokens_details": { "cached_tokens": cache_read },
            "output_tokens_details": { "reasoning_tokens": 0 },
        },
    })
}

/// 上游 anthropic SSE 全量聚合 → Responses response 对象（非流式）
pub fn aggregate_sse_to_responses(raw: &str, model: &str) -> Value {
    let mut text = String::new();
    let mut tools = ToolAccum::new();
    let mut input = 0i64;
    let mut output = 0i64;
    let mut cache_read = 0i64;
    for line in raw.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(d) => d.trim(),
            None => continue,
        };
        match translate_sse_line(data) {
            Some(Delta::Content(s)) => text.push_str(&s),
            Some(Delta::ToolStart { index, id, name }) => tools.add_start(index, &id, &name),
            Some(Delta::ToolArgs { index, args }) => tools.add_args(index, &args),
            Some(Delta::Usage { input: i, cache_read: cr, .. }) => {
                input = i;
                cache_read = cr;
            }
            Some(Delta::FinishUsage { output: o, .. }) => output = o,
            _ => {}
        }
    }
    let id = format!("resp_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
    responses_object_with_tools(&id, model, &text, "completed", input, output, cache_read, Some(&tools))
}

fn sse_frame(v: &Value) -> String {
    let typ = v["type"].as_str().unwrap_or("");
    format!("event: {typ}\ndata: {v}\n\n")
}

/// 上游 anthropic SSE → Responses 事件流装配器（M5，Go streamResponses 同构）。
/// feed 吞任意切分的上游字节（内部按事件缓冲），返回可直接下发的 SSE 文本。
/// 事件序列：response.created / output_item.added(message) → output_text.delta、
/// function_call 的 added+arguments.delta → output_item.done×N → response.completed。
pub struct ResponsesStream {
    model: String,
    rid: String,
    mid: String,
    buf: String,
    /// created + message added 两帧，首次 feed 前置下发（上游建联成功后立即可见）
    pending: String,
    text: String,
    tools: ToolAccum,
    usage_in: i64,
    usage_out: i64,
    usage_cr: i64,
}

impl ResponsesStream {
    pub fn new(model: &str) -> Self {
        let rid = format!("resp_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
        let mid = format!("msg_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
        let pending = sse_frame(&json!({
            "type": "response.created",
            "response": responses_object(&rid, model, "", "in_progress", 0, 0, 0),
        })) + &sse_frame(&json!({
            "type": "response.output_item.added", "output_index": 0,
            "item": { "id": mid, "type": "message", "status": "in_progress",
                      "role": "assistant", "content": [] },
        }));
        Self {
            model: model.to_string(),
            rid,
            mid,
            buf: String::new(),
            pending,
            text: String::new(),
            tools: ToolAccum::new(),
            usage_in: 0,
            usage_out: 0,
            usage_cr: 0,
        }
    }

    /// 取走首部两帧（在进入 chunk 循环前发，客户端即刻见到会话建立）
    pub fn take_pending(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    pub fn feed(&mut self, chunk: &str) -> String {
        let mut out = std::mem::take(&mut self.pending);
        self.buf.push_str(chunk);
        while let Some(pos) = self.buf.find("\n\n") {
            let event: String = self.buf.drain(..pos + 2).collect();
            for line in event.lines() {
                let data = match line.strip_prefix("data: ") {
                    Some(d) => d.trim(),
                    None => continue,
                };
                match translate_sse_line(data) {
                    Some(Delta::Usage { input, cache_read, .. }) => {
                        self.usage_in = input;
                        self.usage_cr = cache_read;
                    }
                    Some(Delta::FinishUsage { output, .. }) => self.usage_out = output,
                    Some(Delta::Content(t)) => {
                        self.text.push_str(&t);
                        out.push_str(&sse_frame(&json!({
                            "type": "response.output_text.delta", "item_id": self.mid,
                            "output_index": 0, "content_index": 0, "delta": t,
                        })));
                    }
                    // 思考块不透出（Go 版同构：Responses 侧只转发文本与工具）
                    Some(Delta::ToolStart { index, id, name }) => {
                        self.tools.add_start(index, &id, &name);
                        let fc = self.tools.fc_id(index).to_string();
                        out.push_str(&sse_frame(&json!({
                            "type": "response.output_item.added", "output_index": index + 1,
                            "item": { "id": fc, "type": "function_call", "status": "in_progress",
                                      "call_id": id, "name": name, "arguments": "" },
                        })));
                    }
                    Some(Delta::ToolArgs { index, args }) => {
                        self.tools.add_args(index, &args);
                        let fc = self.tools.fc_id(index).to_string();
                        out.push_str(&sse_frame(&json!({
                            "type": "response.function_call_arguments.delta", "item_id": fc,
                            "output_index": index + 1, "delta": args,
                        })));
                    }
                    Some(Delta::Error(msg)) => {
                        out.push_str(&sse_frame(&json!({ "type": "error", "error": { "message": msg } })));
                    }
                    _ => {}
                }
            }
        }
        out
    }

    pub fn finish(&mut self) -> String {
        let mut out = std::mem::take(&mut self.pending);
        for &idx in self.tools.order() {
            let (fc_id, call_id, name, args) = self.tools.call(idx);
            let args = if args.is_empty() { "{}" } else { args };
            out.push_str(&sse_frame(&json!({
                "type": "response.output_item.done", "output_index": idx + 1,
                "item": { "id": fc_id, "type": "function_call", "status": "completed",
                          "call_id": call_id, "name": name, "arguments": args },
            })));
        }
        out.push_str(&sse_frame(&json!({
            "type": "response.output_item.done", "output_index": 0,
            "item": { "id": self.mid, "type": "message", "status": "completed",
                      "role": "assistant",
                      "content": [{ "type": "output_text", "text": self.text, "annotations": [] }] },
        })));
        let obj = responses_object_with_tools(
            &self.rid, &self.model, &self.text, "completed", self.usage_in, self.usage_out,
            self.usage_cr, Some(&self.tools),
        );
        out.push_str(&sse_frame(&json!({ "type": "response.completed", "response": obj })));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_includes_tool_calls() {
        let sse = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"get_weather\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\":\\\"BJ\\\"}\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"查完了\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n",
        );
        let out = aggregate_sse_to_responses(sse, "GLM-5.3-Flash");
        assert_eq!(out["status"], "completed");
        assert_eq!(out["output"][0]["type"], "message");
        assert_eq!(out["output"][0]["content"][0]["text"], "查完了");
        let fc = &out["output"][1];
        assert_eq!(fc["type"], "function_call");
        assert_eq!(fc["call_id"], "toolu_1");
        assert_eq!(fc["name"], "get_weather");
        assert_eq!(fc["arguments"], "{\"city\":\"BJ\"}");
        assert_eq!(out["usage"]["total_tokens"], 16);
    }

    #[test]
    fn stream_survives_split_events_and_completes() {
        let sse = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"想\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let mut s = ResponsesStream::new("GLM-5.3-Flash");
        let pre = s.take_pending();
        assert!(pre.contains("\"response.created\""));
        assert!(pre.contains("response.output_item.added"));
        // 撕裂事件边界验证内部缓冲
        let (a, b) = sse.split_at(sse.len() / 2);
        let out = format!("{}{}", s.feed(a), s.feed(b));
        assert!(out.contains("\"response.output_text.delta\""));
        assert_eq!(out.matches("\"delta\":\"你\"").count(), 1);
        assert_eq!(out.matches("\"delta\":\"好\"").count(), 1);
        assert!(!out.contains("想")); // 思考不透出
        let fin = s.finish();
        assert!(fin.contains("\"response.output_item.done\""));
        assert!(fin.contains("\"response.completed\""));
        assert!(fin.contains("\"total_tokens\":8"));
    }

    #[test]
    fn stream_tool_events_and_empty_args_guard() {
        let sse = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"f\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n",
        );
        let mut s = ResponsesStream::new("GLM-5.3-Flash");
        let _ = s.take_pending();
        let out = s.feed(sse);
        assert!(out.contains("\"response.output_item.added\""));
        assert!(out.contains("\"function_call\""));
        assert!(out.contains("\"response.function_call_arguments.delta\""));
        let fin = s.finish();
        // done 事件里 function_call 与 message 各一项；空 arguments 补 "{}"
        assert!(fin.contains("\"type\":\"function_call\""));
        assert!(fin.contains("\"arguments\":\"{}\""));
        let _ = fin.find("\"response.completed\"").unwrap();
        // completed 对象：纯工具调用时省略 message 项（全帧仅 output_item.done 事件里一处）
        assert_eq!(fin.matches("\"type\":\"message\"").count(), 1);
    }
}
