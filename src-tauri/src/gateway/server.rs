// GATEWAY HTTP 服务：axum 路由 + Bearer 鉴权 + health + /v1/models 静态列表
// M2-M3：/v1/messages 直通聚合；/v1/chat/completions OpenAI 转换（非流式聚合 + SSE 流式）。
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::{openai, pool, translate, upstream};

struct SvcState {
    api_key: String,
    http: reqwest::Client,
    /// 换号重试次数（首次尝试之外，配置面）
    max_retries: u32,
    /// 全局风控退避秒数（配置面）
    backoff_secs: u64,
    /// SSE keepalive 秒数（配置面；0 = 关闭）
    keepalive_secs: u64,
    /// per-account 模型面缓存：id → (抓取时刻, Some(模型集)=已确认 / None=拉取失败)。
    /// pick 按模型路由用：失败负缓存 60s 内放行该号（避免网络抖动把号误踢出池）。
    /// /v1/models 聚合共用这一份缓存——不另设池级缓存，一份 balance 拉取两处受益
    models_by_acct: tokio::sync::RwLock<std::collections::HashMap<String, (std::time::Instant, Option<Vec<String>>)>>,
    /// 跨线程共享：pool 调度器 + 请求日志环 + 计数（twoapi_status 经 TwoApiState 读取）
    shared: std::sync::Arc<super::GatewayShared>,
}

pub async fn serve(
    addr: std::net::SocketAddr,
    cfg: super::config::GatewayConfig,
    mut shutdown: watch::Receiver<bool>,
    shared: std::sync::Arc<super::GatewayShared>,
) {
    // 连接超时可配；不设整体读超时——SSE 流式回答持续数分钟是正常形态
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(cfg.upstream_connect_secs))
        .build()
        .expect("gateway http client");
    let max_retries = cfg.max_retries;
    let backoff_secs = cfg.global_backoff_secs;
    let cors_origins = cfg.cors_origins.clone();
    let keepalive_secs = cfg.keepalive_secs;
    let total_timeout_secs = cfg.total_timeout_secs;
    shared.pool.set_sticky(cfg.sticky);
    shared.pool.set_allowed_fails(cfg.allowed_fails);
    let state = std::sync::Arc::new(SvcState {
        api_key: cfg.api_key,
        http,
        max_retries,
        backoff_secs,
        keepalive_secs,
        models_by_acct: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        shared,
    });
    let app = axum::Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/messages", post(messages))
        .route("/v1/responses", post(responses_endpoint))
        .layer(axum::extract::DefaultBodyLimit::max(
            (cfg.body_limit_mb * 1024 * 1024).max(1) as usize,
        ))
        .layer(axum::middleware::from_fn_with_state(
            std::time::Duration::from_secs(total_timeout_secs),
            timeout_mw,
        ))
        .layer(axum::middleware::from_fn_with_state(cors_origins, cors_mw))
        .with_state(state.clone());

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            crate::flowlog::log("gateway", "bind-fail", &format!("{addr}: {e}"));
            eprintln!("[gateway] bind {addr} failed: {e}");
            return;
        }
    };
    crate::flowlog::log("gateway", "serving", &addr.to_string());
    eprintln!("[gateway] serving on {addr}");
    // 启动预热：后台拉一次全池模型面，池面板/账号行不用等第一个请求才有模型数据
    {
        let st = state.clone();
        tokio::spawn(async move {
            let mut members = match super::pool::members() {
                Ok(m) => m,
                Err(_) => return,
            };
            if !members.is_empty() {
                ensure_model_faces(&st, &mut members).await;
            }
        });
    }
    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.changed().await;
        })
        .await;
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "gateway" }))
}

/// Bearer 鉴权：Authorization: Bearer <api_key>，配置为空时拒绝所有
fn check_auth(state: &SvcState, headers: &HeaderMap) -> Result<(), StatusCode> {
    if state.api_key.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // 双形态鉴权：OpenAI 形状用 Authorization: Bearer；Anthropic 形状（anthropic-compatible
    // 客户端，如 AtomCode）标准是 x-api-key 头——两种都接受，任一命中即放行
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let xkey = headers.get("x-api-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if bearer != state.api_key && xkey != state.api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

/// /v1/models：动态模型面——聚合池内账号 live 桶的模型并集（live 判定见 fetch_model_names）。
/// 与请求路由共用同一份号级缓存（ensure_model_faces）：缓存命中零网络，miss 才并发拉取回填；
/// 不另设池级缓存，避免同一份 balance 两条缓存各拉各的。
async fn models(State(state): State<std::sync::Arc<SvcState>>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    check_auth(&state, &headers)?;
    let model = |id: &str| {
        json!({
            "id": id, "object": "model", "created": 0, "owned_by": "zcode-hub",
            "permission": [], "root": id, "parent": null,
        })
    };
    let members = super::pool::members().unwrap_or_default();
    let mut members = members;
    ensure_model_faces(&state, &mut members).await;
    let mut ids: Vec<String> = Vec::new();
    for m in &members {
        // models: None（拉取失败/未知）不贡献并集——该号按万能号放行请求，
        // 但 /v1/models 不替它虚构模型名；models: Some(空) 也不贡献
        if let Some(list) = &m.models {
            for name in list {
                if !ids.iter().any(|x| x.eq_ignore_ascii_case(name)) {
                    ids.push(name.clone());
                }
            }
        }
    }
    // 聚合成功写回 GatewayShared：gateway_status（UI 模型列表）同源生效
    if !ids.is_empty() {
        if let Ok(mut shared) = state.shared.models.lock() {
            *shared = ids.clone();
        }
    }
    // 全号模型面未知/为空时回落静态表保底（与旧行为一致）
    let list: Vec<String> = if ids.is_empty() {
        crate::gateway::MODEL_LIST.iter().map(|s| s.to_string()).collect()
    } else {
        ids
    };
    Ok(Json(json!({
        "object": "list",
        "data": list.iter().map(|id| model(id)).collect::<Vec<_>>(),
    })))
}

/// 单账号 entitlements 抓取：GET billing/balance，取 balances[].show_name 去重。
/// 失败返回空（不连坐聚合）。
/// 数值字段兼容：数字或数字字符串（magpie startNum 同款，老口径 balance 会给字符串）
fn balance_num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

/// 桶死活判定（magpie giftSpent 同款）：余量字段优先，缺失时用 used/total 推。
/// 「Both the card and the request route use the same test for a spent bucket」——
/// 路由面和额度卡必须同一把尺子，这里只服务路由面。
fn bucket_spent(b: &Value) -> bool {
    match b.get("remaining_units").and_then(balance_num) {
        Some(left) => left <= 0.0,
        None => match (
            b.get("total_units").and_then(balance_num),
            b.get("used_units").and_then(balance_num),
        ) {
            (Some(t), Some(u)) => u >= t,
            _ => false,
        },
    }
}

/// 桶归属判定（magpie same() 同款）：user_plan_id 双方都有才用它，否则比 plan_id
fn bucket_owned_by(b: &Value, p: &Value) -> bool {
    if let (Some(x), Some(y)) = (b.get("user_plan_id"), p.get("user_plan_id")) {
        if x.is_string() && y.is_string() {
            return x == y;
        }
    }
    fn pid(v: &Value) -> &str {
        v.get("plan_id").and_then(Value::as_str).unwrap_or("")
    }
    !pid(b).is_empty() && pid(b) == pid(p)
}

async fn fetch_model_names(
    http: &reqwest::Client,
    token: &str,
    mid: Option<String>,
) -> Option<Vec<String>> {
    let url = format!(
        "{}?app_version={}",
        crate::quota::BILLING_BALANCE_URL,
        crate::quota::zcode_app_version()
    );
    let mut req = http.get(&url).timeout(std::time::Duration::from_secs(8));
    for (k, v) in crate::quota::zai_billing_headers_with_mid(token, mid) {
        req = req.header(k, v);
    }
    let Ok(resp) = req.send().await else {
        return None;
    };
    // 错误响应（401/3012 风控体/429）往往也是合法 JSON 但没有 balances——按失败处理进负缓存，
    // 不能落进 Some(空) 被误判成「确认无桶」踢出池
    if !resp.status().is_success() {
        return None;
    }
    let Ok(v) = resp.json::<Value>().await else {
        return None;
    };
    if !crate::quota::business_ok(&v) {
        return None;
    }
    // 模型面 = live 桶的模型并集（magpie zcode 插件 startPlan 同款语义）：
    // plan status=active 且未过 ends_at；桶 expires_at 未过、余量未尽——spent 桶仍声明
    // 模型但不可扣，进路由面只会把请求喂给必败号。桶的模型来自 capabilities 的
    // "model:" 条目（show_name 只是显示名），缺失时回落 show_name。
    // now 以 server_time 为基准，防本机时钟偏差误杀刚领的桶。
    let now = v
        .pointer("/data/server_time")
        .and_then(balance_num)
        .filter(|t| *t > 0.0)
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0)
        });
    let plan_live = |p: &Value| -> bool {
        let st = p
            .get("status")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default();
        if st != "active" {
            return false;
        }
        let end = p.get("ends_at").and_then(balance_num).unwrap_or(0.0);
        !(end > 0.0 && end <= now)
    };
    let plans = v.pointer("/data/plans").and_then(Value::as_array);
    let mut out: Vec<String> = Vec::new();
    if let Some(balances) = v.pointer("/data/balances").and_then(Value::as_array) {
        for b in balances {
            // plans 字段在才做归属校验（plans 空或无 live plan → 全部桶不归属 → 空模型面）；
            // 字段缺失的响应按无 plan 结构处理，桶只走自身 live 判定
            if let Some(ps) = plans {
                if !ps.iter().any(|p| plan_live(p) && bucket_owned_by(b, p)) {
                    continue;
                }
            }
            let exp = b.get("expires_at").and_then(balance_num).unwrap_or(0.0);
            if exp > 0.0 && exp <= now {
                continue;
            }
            if bucket_spent(b) {
                continue;
            }
            let caps: Vec<String> = b
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(|c| c.trim())
                        .filter(|c| c.starts_with("model:") || !c.contains(':'))
                        .map(|c| c.trim_start_matches("model:").trim().to_string())
                        .filter(|c| !c.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let names = if caps.is_empty() {
                b.get("show_name")
                    .and_then(Value::as_str)
                    .map(|s| vec![s.trim().to_string()])
                    .unwrap_or_default()
            } else {
                caps
            };
            for m in names {
                if m.is_empty() || out.iter().any(|x| x.eq_ignore_ascii_case(&m)) {
                    continue;
                }
                // 对齐静态表的 catalog 大小写（capabilities 全小写，下拉/客户端展示宜用 GLM-5.3 形态）
                let m = crate::gateway::MODEL_LIST
                    .iter()
                    .find(|x| x.eq_ignore_ascii_case(&m))
                    .map(|x| x.to_string())
                    .unwrap_or(m);
                out.push(m);
            }
        }
    }
    // 成功响应（含空桶表）返回 Some——空表是「确认无任何桶」，不能和请求失败混成一种
    Some(out)
}

/// pool_send 选号前补齐成员模型面：缓存命中直接回填，models: None 的号现拉并回写缓存。
/// 正缓存 5 分钟；失败写负缓存（60s 内视为 None 放行该号）。
async fn ensure_model_faces(state: &SvcState, members: &mut [pool::PoolMember]) {
    const POS_TTL: std::time::Duration = std::time::Duration::from_secs(300);
    const NEG_TTL: std::time::Duration = std::time::Duration::from_secs(60);
    let mut to_fetch: Vec<usize> = Vec::new();
    let mut fill: Vec<(usize, Vec<String>)> = Vec::new();
    {
        let cache = state.models_by_acct.read().await;
        for (i, m) in members.iter().enumerate() {
            if m.models.is_some() {
                continue;
            }
            match cache.get(&m.id) {
                Some((at, face)) if face.is_some() && at.elapsed() < POS_TTL => {
                    fill.push((i, face.clone().unwrap()));
                }
                Some((at, face)) if face.is_none() && at.elapsed() < NEG_TTL => {}
                _ => to_fetch.push(i),
            }
        }
    }
    for (i, face) in fill {
        members[i].models = Some(face);
    }
    if to_fetch.is_empty() {
        return;
    }
    // 并发拉取：互不依赖，冷启动 14 号从串行最坏 ~100s（8s 超时×14）压到单轮 ~8s
    let mut handles = Vec::new();
    for &i in &to_fetch {
        let http = state.http.clone();
        let token = members[i].token.clone();
        let mid = members[i].mid.clone();
        handles.push((i, tokio::spawn(async move { fetch_model_names(&http, &token, mid).await })));
    }
    let mut fetched: Vec<(usize, Option<Vec<String>>)> = Vec::new();
    for (i, h) in handles {
        // JoinError（任务 panic/取消）按拉取失败处理，不连坐其他号
        let face = h.await.unwrap_or(None);
        members[i].models = face.clone();
        fetched.push((i, face));
    }
    let mut cache = state.models_by_acct.write().await;
    for (i, face) in fetched {
        cache.insert(members[i].id.clone(), (std::time::Instant::now(), face.clone()));
        // 镜像到 shared：gateway_status 拼进池成员，前端展示每号模型面
        if let Ok(mut faces) = state.shared.model_faces.lock() {
            faces.insert(members[i].id.clone(), face);
        }
    }
}

/// /v1/messages（M4 完整版）：入站 stream=true 时上游 SSE 原样透传（Anthropic 原生客户端
/// 自行解析事件流）；stream=false/缺省时聚合为非流式 message。
async fn messages(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    // 请求关联 ID：换号重试产生的多条日志共用；错误响应体回传供客户端对账
    let req_id = uuid::Uuid::new_v4().simple().to_string();
    // 调用方标识：截断入日志（ZCode / Claude Code / curl 等 UA 各异），区分请求来源
    let ua: String = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(120).collect())
        .unwrap_or_default();
    let body_json: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string()))),
    };
    let model = body_json
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("GLM-5.3-Flash")
        .to_string();
    let stream = body_json.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let session = session_of(&headers, &body_json);
    let sticky = session.as_deref().map_or(pool::Sticky::None, pool::Sticky::Session);
    let prepared = match translate::anthropic_to_upstream(&body_json) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e))),
    };
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let req_preview = clip(&String::from_utf8_lossy(&body), LOG_REQ_CAP);
    if !stream {
        let ok = pool_send(&state, &prepared, "/v1/messages", &model, stream, &req_preview, &req_id, sticky).await?;
        let bytes = match ok.reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let out = translate::aggregate_sse(&raw, &model);
        ok.settle.settle_success();
        push_ok_log(&state.shared, "/v1/messages", &ok.account, ok.started.elapsed().as_millis() as u64, ok.ttft_ms, ok.attempt, &model, stream, &req_id, &ua, &req_preview, false, Some(clip(&out.to_string(), LOG_RESP_CAP)));
        return Ok(Json(out).into_response());
    }
    // 流式：上游 SSE 原样透传（Anthropic 原生客户端，事件形态一致，零转换）
    let ok = pool_send(&state, &prepared, "/v1/messages", &model, stream, &req_preview, &req_id, sticky).await?;
    let UpstreamOk { reply, account, attempt, ttft_ms, started, req_id, settle } = ok;
    let resp = match reply {
        UpstreamReply::Stream(r) => r,
    };
    let shared = std::sync::Arc::clone(&state.shared);
    let keepalive = state.keepalive_secs;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut resp = resp;
        let mut acc = String::new(); // 下游透传原文累积（截断入日志）
        // 上游异常断流检测：message_stop 未出现即视为截断。实测形态：上游 502/连接重置
        // 掐在流中途，网关原样收尾 → 客户端只见半截输出且无法确认工具结果
        // （Claude Code 表现为 "incomplete or unconfirmed tool output"）。
        // 收流合成 error 事件把静默截断转成可重试的 overloaded_error，客户端会自动恢复。
        let mut saw_stop = false;
        // SSE keepalive：上游静默超阈值时发 ": ping" 注释帧（SSE 规范里注释会被客户端忽略），
        // 防止中间层把看似空闲的连接掐掉——模型长思考场景真实存在
        let mut idle = tokio::time::interval(std::time::Duration::from_secs(keepalive.max(1)));
        idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        idle.tick().await; // 首个 tick 立即返回，跳过
        let alive = keepalive > 0;
        loop {
            let chunk = if alive {
                tokio::select! {
                    c = resp.chunk() => c,
                    _ = idle.tick() => {
                        // 静默期：发注释帧保活（不算响应内容，不进 acc）
                        if tx.send(Ok(bytes::Bytes::from_static(b": ping\n\n"))).await.is_err() {
                            break;
                        }
                        continue;
                    }
                }
            } else {
                resp.chunk().await
            };
            match chunk {
                Ok(Some(c)) => {
                    if !saw_stop && c.windows(12).any(|w| w == b"message_stop") {
                        saw_stop = true;
                    }
                    if acc.chars().count() < LOG_RESP_CAP {
                        acc.push_str(&String::from_utf8_lossy(&c));
                    }
                    if tx.send(Ok(c)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        let truncated = !saw_stop;
        if truncated {
            const TRUNC_TAIL: &str = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"upstream stream ended before message_stop (zcode-hub gateway)\"}}\n\n";
            let _ = tx.send(Ok(bytes::Bytes::from_static(TRUNC_TAIL.as_bytes()))).await;
            if acc.chars().count() < LOG_RESP_CAP {
                acc.push_str(TRUNC_TAIL);
            }
        }
        settle.settle_success();
        push_ok_log(
            &shared,
            "/v1/messages", &account, started.elapsed().as_millis() as u64, ttft_ms, attempt, &model, stream, &req_id, &ua, &req_preview, truncated, Some(clip(&acc, LOG_RESP_CAP)),
        );
    });
    let mut resp = Response::new(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    Ok(resp)
}

/// /v1/chat/completions（M3）：OpenAI 入站 → anthropic 上游。
/// 非流式：上游 SSE 聚合为 chat.completion；流式：逐块转 chat.completion.chunk。入站一律转 stream=true。
async fn chat_completions(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    // 请求关联 ID：换号重试产生的多条日志共用；错误响应体回传供客户端对账
    let req_id = uuid::Uuid::new_v4().simple().to_string();
    // 调用方标识：截断入日志（ZCode / Claude Code / curl 等 UA 各异），区分请求来源
    let ua: String = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(120).collect())
        .unwrap_or_default();
    let req: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string())))?;
    let model = req
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("GLM-5.3-Flash")
        .to_string();
    let stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let session = session_of(&headers, &req);
    let sticky = session.as_deref().map_or(pool::Sticky::None, pool::Sticky::Session);
    let prepared = openai::openai_to_upstream(&req)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e)))?;
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let req_preview = clip(&String::from_utf8_lossy(&body), LOG_REQ_CAP);
    if !stream {
        let ok = pool_send(&state, &prepared, "/v1/chat/completions", &model, stream, &req_preview, &req_id, sticky).await?;
        let bytes = match ok.reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let out = openai::aggregate_sse_to_openai(&raw, &model);
        ok.settle.settle_success();
        push_ok_log(&state.shared, "/v1/chat/completions", &ok.account, ok.started.elapsed().as_millis() as u64, ok.ttft_ms, ok.attempt, &model, stream, &req_id, &ua, &req_preview, false, Some(clip(&out.to_string(), LOG_RESP_CAP)));
        return Ok(Json(out).into_response());
    }

    let ok = pool_send(&state, &prepared, "/v1/chat/completions", &model, stream, &req_preview, &req_id, sticky).await?;
    let UpstreamOk { reply, account, attempt, ttft_ms, started, req_id, settle } = ok;
    let resp = match reply {
        UpstreamReply::Stream(r) => r,
    };
    let shared = std::sync::Arc::clone(&state.shared);
    let keepalive = state.keepalive_secs;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut conv = openai::OpenAiStream::new(&model);
        let mut resp = resp;
        let mut acc = String::new(); // 下游 chunk 帧累积（截断入日志）
        // 截断检测：与 /v1/messages 同款——上游（Anthropic SSE）收尾必须含 message_stop，
        // 否则视为中途断流，先发 OpenAI 式 error 帧再正常收尾
        let mut saw_stop = false;
        // SSE keepalive：与 /v1/messages 同款（OpenAI 流注释帧同样被客户端忽略）
        let mut idle = tokio::time::interval(std::time::Duration::from_secs(keepalive.max(1)));
        idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        idle.tick().await;
        let alive = keepalive > 0;
        loop {
            let chunk = if alive {
                tokio::select! {
                    c = resp.chunk() => c,
                    _ = idle.tick() => {
                        if tx.send(Ok(bytes::Bytes::from_static(b": ping\n\n"))).await.is_err() {
                            break;
                        }
                        continue;
                    }
                }
            } else {
                resp.chunk().await
            };
            match chunk {
                Ok(Some(c)) => {
                    if !saw_stop && c.windows(12).any(|w| w == b"message_stop") {
                        saw_stop = true;
                    }
                    let out = conv.feed(&String::from_utf8_lossy(&c));
                    if acc.chars().count() < LOG_RESP_CAP {
                        acc.push_str(&out);
                    }
                    if !out.is_empty() && tx.send(Ok(bytes::Bytes::from(out))).await.is_err() {
                        break; // 客户端断开
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break;
                }
            }
        }
        let truncated = !saw_stop;
        if truncated {
            const TRUNC_FRAME: &str = "data: {\"error\":{\"type\":\"server_error\",\"code\":\"overloaded_error\",\"message\":\"upstream stream ended before message_stop (zcode-hub gateway)\"}}\n\n";
            let _ = tx.send(Ok(bytes::Bytes::from_static(TRUNC_FRAME.as_bytes()))).await;
            if acc.chars().count() < LOG_RESP_CAP {
                acc.push_str(TRUNC_FRAME);
            }
        }
        let fin = conv.finish();
        if acc.chars().count() < LOG_RESP_CAP {
            acc.push_str(&fin);
        }
        let _ = tx.send(Ok(bytes::Bytes::from(fin))).await;
        settle.settle_success();
        push_ok_log(&shared, "/v1/chat/completions", &account, started.elapsed().as_millis() as u64, ttft_ms, attempt, &model, stream, &req_id, &ua, &req_preview, truncated, Some(clip(&acc, LOG_RESP_CAP)));
    });
    let mut resp = Response::new(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    Ok(resp)
}

enum UpstreamReply {
    /// 上游统一走 stream=true，非流式路径由调用侧 bytes().await 聚合
    Stream(reqwest::Response),
}

/// 成功路径的延迟记账句柄：上游 user 并发按活跃流计（3008 语义），在飞窗口
/// 必须覆盖整个流式读取期——响应头到达即释放会让池内计数小于上游真实占用，
/// session pin 下的并行请求必然超发。消费点收尾调 settle_success()；句柄被
/// Drop 且未记账时（客户端中途断开等）按成功兜底落账——连接断开不代表账号
/// 坏了，且在飞名额必须回收，否则永久泄漏。
/// settle(ok=true) 只用 inner.sticky 开关挪游标、不碰会话表，故此处 Sticky::None
/// 与原调用点的 sticky 参数语义完全等价。
struct SettleGuard {
    shared: std::sync::Arc<super::GatewayShared>,
    member_id: String,
    idx: usize,
    member_count: usize,
    done: std::sync::atomic::AtomicBool,
}

impl SettleGuard {
    fn new(
        shared: std::sync::Arc<super::GatewayShared>,
        member_id: String,
        idx: usize,
        member_count: usize,
    ) -> Self {
        Self {
            shared,
            member_id,
            idx,
            member_count,
            done: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn settle_success(&self) {
        if !self.done.swap(true, std::sync::atomic::Ordering::Relaxed) {
            self.shared
                .pool
                .settle(&self.member_id, self.idx, self.member_count, true, 0, pool::Sticky::None);
        }
    }
}

impl Drop for SettleGuard {
    fn drop(&mut self) {
        if !self.done.swap(true, std::sync::atomic::Ordering::Relaxed) {
            self.shared
                .pool
                .settle(&self.member_id, self.idx, self.member_count, true, 0, pool::Sticky::None);
        }
    }
}

/// 手写整体请求超时中间件（不引 tower-http）：兜底防请求永久挂死（如上游 TCP 半开）。
/// 0 = 关闭。流式回答正常持续数分钟，默认 600s 只拦真正的挂死，不会掐断长回答。
/// 超时后连接被断开，客户端侧表现为连接重置——比永久悬挂可诊断得多
async fn timeout_mw(
    State(limit): State<std::time::Duration>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if limit.is_zero() {
        return next.run(req).await;
    }
    match tokio::time::timeout(limit, next.run(req)).await {
        Ok(resp) => resp,
        Err(_) => {
            let mut resp = Response::new(axum::body::Body::from(
                "{\"error\":{\"type\":\"timeout_error\",\"message\":\"gateway total timeout exceeded\"}}",
            ));
            *resp.status_mut() = StatusCode::GATEWAY_TIMEOUT;
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            resp
        }
    }
}

/// 手写 CORS 中间件（不引 tower-http）：精确匹配 state.cors_origins；含 "*" 放行全部。
/// 空列表 = 不发 CORS 头（本机 CLI 调用不受影响，浏览器端会被同源策略拦）。
/// OPTIONS 预检直接回 204（带对应头），不带鉴权——预检请求按规范不携带凭据。
async fn cors_mw(
    State(origins): State<Vec<String>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let Some(origin) = origin else {
        // 无 Origin 头：非浏览器调用，原样放行
        return next.run(req).await;
    };
    let allow = origins.iter().any(|o| o == "*" || o == &origin);
    if req.method() == axum::http::Method::OPTIONS {
        let mut resp = Response::new(axum::body::Body::empty());
        if allow {
            *resp.status_mut() = StatusCode::NO_CONTENT;
            cors_headers(&mut resp, &origin, true);
        } else {
            *resp.status_mut() = StatusCode::FORBIDDEN;
        }
        return resp;
    }
    let mut resp = next.run(req).await;
    if allow {
        cors_headers(&mut resp, &origin, false);
    }
    resp
}

fn cors_headers(resp: &mut Response, origin: &str, preflight: bool) {
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    if preflight {
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Content-Type, anthropic-version, x-api-key"),
        );
        h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    }
}

/// pool_send 成功后的登记材料：成功日志由 handler 推（响应体聚合完成后才完整）。
/// started 用于 handler 在消费点算总耗时；ttft_ms = 上游响应头到达（流式即首帧）时间
struct UpstreamOk {
    reply: UpstreamReply,
    account: String,
    attempt: usize,
    ttft_ms: u64,
    started: std::time::Instant,
    /// 请求关联 ID：一次客户端请求（含换号重试产生的多条日志）共用
    req_id: String,
    /// 延迟记账句柄：消费点收尾时 settle_success()，覆盖完整流式窗口
    settle: SettleGuard,
}

/// 日志 body 截断：超长按字符裁切并标记，避免单条请求把日志环/落盘撑爆
fn clip(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let head: String = s.chars().take(cap).collect();
    format!("{head}…[截断，共 {} 字符]", s.chars().count())
}

const LOG_REQ_CAP: usize = 8192;
const LOG_RESP_CAP: usize = 16384;

/// 从聚合后的响应文本提取 usage：输入 / 输出 / 缓存读 / 缓存写。
/// 响应文本两种载体：非流式路径存聚合 JSON（顶层 /usage），流式路径存 SSE 全文
/// （anthropic 的 message_start/message_delta，openai/responses 的逐帧 /usage）。
/// 字段名三套别名：anthropic（input_tokens/cache_read_input_tokens/…）、
/// chat（prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens）、
/// responses（input_tokens/output_tokens/input_tokens_details.cached_tokens）。
fn usage_get(u: &Value, k: &str) -> Option<i64> {
    u.get(k).and_then(|x| x.as_i64())
}

fn usage_in(u: &Value) -> Option<i64> {
    usage_get(u, "input_tokens").or_else(|| usage_get(u, "prompt_tokens"))
}

fn usage_out(u: &Value) -> Option<i64> {
    usage_get(u, "output_tokens").or_else(|| usage_get(u, "completion_tokens"))
}

fn usage_cache_read(u: &Value) -> Option<i64> {
    usage_get(u, "cache_read_input_tokens")
        .or_else(|| u.pointer("/input_tokens_details/cached_tokens").and_then(|x| x.as_i64()))
        .or_else(|| u.pointer("/prompt_tokens_details/cached_tokens").and_then(|x| x.as_i64()))
}

fn usage_cache_write(u: &Value) -> Option<i64> {
    usage_get(u, "cache_creation_input_tokens")
}

fn extract_usage(resp: Option<&String>) -> (i64, i64, i64, i64) {
    let Some(raw) = resp else { return (0, 0, 0, 0) };
    let mut tin = 0i64;
    let mut tout = 0i64;
    let mut tcr = 0i64;
    let mut tcw = 0i64;
    // 载体一：整段是聚合 JSON（非流式路径）
    if let Ok(v) = serde_json::from_str::<Value>(raw.trim()) {
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            if let Some(x) = usage_in(u) { tin = x; }
            if let Some(x) = usage_out(u) { tout = x; }
            if let Some(x) = usage_cache_read(u) { tcr = x; }
            if let Some(x) = usage_cache_write(u) { tcw = x; }
            return (tin, tout, tcr, tcw);
        }
    }
    // 载体二：SSE 全文逐行（流式路径）
    for line in raw.lines() {
        let Some(d) = line.strip_prefix("data: ") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(d.trim()) else { continue };
        let Some(u) = v.pointer("/message/usage").or_else(|| v.pointer("/usage")) else { continue };
        if let Some(x) = usage_in(u) { tin = x; }
        if let Some(x) = usage_out(u) { tout = x; }
        if let Some(x) = usage_cache_read(u) { tcr = x; }
        if let Some(x) = usage_cache_write(u) { tcw = x; }
    }
    (tin, tout, tcr, tcw)
}

/// 从响应载体提取停止原因：非流式聚合 JSON（anthropic stop_reason / openai finish_reason）；
/// 流式 SSE 的 message_delta 帧。空串 = 未能取得（截断/错误响应）
fn extract_finish(resp: Option<&String>) -> String {
    let Some(raw) = resp else { return String::new() };
    // 载体一：整段聚合 JSON
    if let Ok(v) = serde_json::from_str::<Value>(raw.trim()) {
        if let Some(s) = v.get("stop_reason").and_then(|x| x.as_str()) {
            return s.to_string();
        }
        if let Some(s) = v.pointer("/choices/0/finish_reason").and_then(|x| x.as_str()) {
            return s.to_string();
        }
        return String::new();
    }
    // 载体二：SSE 逐行
    for line in raw.lines() {
        let Some(d) = line.strip_prefix("data: ") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(d.trim()) else { continue };
        if let Some(s) = v.pointer("/delta/stop_reason").and_then(|x| x.as_str()) {
            return s.to_string();
        }
    }
    String::new()
}

/// 模型定价表（USD / 百万 tokens，按 z.ai 国际站牌价 docs.z.ai/guides/overview/pricing，2026-11 核对）。
/// 缓存写（tcw）当前不参与计费，故无 cache_write 价。模型名不匹配 → cost 为 null（不计价）
fn unit_price(model: &str) -> Option<(f64, f64, f64)> {
    let m = model.to_ascii_lowercase();
    if m.contains("flashx") {
        Some((0.37, 1.25, 0.075)) // GLM-5.3-FlashX
    } else if m.contains("flash") {
        Some((0.15, 0.50, 0.03)) // GLM-5.3-Flash
    } else if m.contains("5.3") || m.contains("5.2") {
        Some((1.4, 4.4, 0.26)) // GLM-5.3 / 5.2 旗舰
    } else {
        None
    }
}

/// 等值折算成本（USD）：tin×输入 + tout×输出 + tcr×缓存读；tcw 当前不计费。
/// 这是「按国际站公开牌价折算」的参考值，实际走套餐额度不产生按量扣费
fn compute_cost(model: &str, tin: i64, tout: i64, tcr: i64) -> Option<f64> {
    let (pin, pout, pcache) = unit_price(model)?;
    let m = 1_000_000f64;
    Some((tin as f64 * pin + tout as f64 * pout + tcr as f64 * pcache) / m)
}

fn push_ok_log(
    shared: &super::GatewayShared,
    ep: &str,
    account: &str,
    ms: u64,
    ttft_ms: u64,
    attempt: usize,
    model: &str,
    stream: bool,
    req_id: &str,
    ua: &str,
    req: &str,
    truncated: bool,
    resp: Option<String>,
) {
    let (tin, tout, tcr, tcw) = extract_usage(resp.as_ref());
    let finish = extract_finish(resp.as_ref());
    let cost = compute_cost(model, tin, tout, tcr);
    shared.push_log(json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "ep": ep, "account": account, "status": 200, "ok": true,
        "model": model, "stream": stream,
        "ms": ms, "ttft": ttft_ms, "attempt": attempt,
        "req_id": req_id,
        "tin": tin, "tout": tout, "tcr": tcr, "tcw": tcw,
        "cost": cost,
        "truncated": truncated,
        "finish": if finish.is_empty() { serde_json::Value::Null } else { serde_json::json!(finish) },
        "ua": if ua.is_empty() { serde_json::Value::Null } else { serde_json::json!(ua) },
        "req": req,
        "resp": resp,
    }));
}
/// 会话标识提取（LiteLLM session affinity 同思路）：专用头优先，其次 body.metadata。
fn session_of(headers: &HeaderMap, body: &Value) -> Option<String> {
    for h in ["x-session-id", "x-claude-code-session-id", "x-litellm-session-id"] {
        if let Some(v) = headers.get(h).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()) {
            return Some(v.to_string());
        }
    }
    body.pointer("/metadata/session_id")
        .or_else(|| body.pointer("/metadata/user_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}


/// pool 分发：选号 → 发上游 → 按错误档收尾。
/// 粘性优先（成功游标不动）；429/3008-3010/5xx/网络错误换号重放（重试次数可配）；
/// 3012/405 全局退避（时长可配）；全员不可用 503；对外状态码经 external_status 归一化
/// （200 包错→429、401/403→503、风控→529）。members/claim_token 都是阻塞面（文件 IO + 解密），丢 blocking 池。
async fn pool_send(
    state: &SvcState,
    prepared: &[u8],
    ep: &str,
    model: &str,
    stream: bool,
    req_preview: &str,
    req_id: &str,
    sticky: pool::Sticky<'_>,
) -> Result<UpstreamOk, (StatusCode, Json<Value>)> {
    let mut members = match tokio::task::spawn_blocking(pool::members).await {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err((StatusCode::SERVICE_UNAVAILABLE, api_error_id("api_error", &e, req_id))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, api_error_id("api_error", &e.to_string(), req_id))),
    };
    if members.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            api_error_id("api_error", "pool: no logged-in account", req_id),
        ));
    }
    // 模型路由：pick 前把 models: None 的号补齐模型面（models_by_acct 正缓存 5 分钟，
    // 失败负缓存 60s，负缓存期内放行该号，避免网络抖动把号误踢出池）
    ensure_model_faces(state, &mut members).await;
    // 初始尝试 + max_retries 次换号重放；全部失败即把最后的错误交回客户端
    for attempt in 0..=state.max_retries as usize {
        let Some(idx) = state.shared.pool.pick(&members, sticky, Some(model)) else {
            if !pool::Pool::any_supports(&members, Some(model)) {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    api_error_id(
                        "model_not_available",
                        &format!("no account in pool supports model {model}"),
                        req_id,
                    ),
                ));
            }
            let wait = state.shared.pool.global_backoff_secs().max(1);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                api_error_id("api_error", &format!("pool unavailable, retry after {wait}s"), req_id),
            ));
        };
        let m = &members[idx];
        let t0 = std::time::Instant::now();
        match upstream::messages_stream(&state.http, &m.token, m.mid.as_deref(), prepared).await {
            Ok(resp) => {
                // 记账延迟到消费点（SettleGuard）——响应头到达即释放会超发并发
                return Ok(UpstreamOk {
                    reply: UpstreamReply::Stream(resp),
                    account: m.name.clone(),
                    // ttft = 上游响应头到达（流式即首帧前导时间）；总耗时由消费点用 started 结算
                    ttft_ms: t0.elapsed().as_millis() as u64,
                    started: t0,
                    attempt,
                    req_id: req_id.to_string(),
                    settle: SettleGuard::new(
                        std::sync::Arc::clone(&state.shared),
                        m.id.clone(),
                        idx,
                        members.len(),
                    ),
                });
            }
            Err(up) => {
                let cd = upstream::cooldown_secs(up.status, &up.body);
                if upstream::is_user_concurrency_limit(&up.body) {
                    // 3008 user 级并发上限：预期内容量拒绝——只释放在飞 + 挪游标 +
                    // 解 pin + 落单次冷却，不进熔断窗口（连撞几次触发 10min 长冷却
                    // 会把全池拖进冷却雪崩，实际容量反而低于设计值）
                    state
                        .shared
                        .pool
                        .settle_transient(&m.id, idx, members.len(), cd, sticky);
                } else {
                    state.shared.pool.settle(&m.id, idx, members.len(), false, cd, sticky);
                }
                // 错误摘要：body 截前 200 字符，展开详情用
                let err_sum: String = up.body.chars().take(200).collect();
                state.shared.push_log(json!({
                    "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    "ep": ep, "account": m.name, "status": up.status, "ok": false,
                    "model": model, "stream": stream,
                    "ms": t0.elapsed().as_millis() as u64,
                    "attempt": attempt,
                    "req_id": req_id,
                    "err": err_sum,
                    "req": req_preview,
                }));
                upstream::note_risk_response(up.status, &up.body);
                if upstream::is_global_risk(up.status, &up.body) {
                    state.shared.pool.global_backoff(state.backoff_secs);
                    // 风控对外一律 529 overloaded：405/3012 与请求方法、客户端鉴权无关
                    //（骑 200/400 均有实锤），透传原始状态会让客户端误判自己的请求错
                    return Err((
                        StatusCode::from_u16(529).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
                        upstream_error_body("overloaded_error", &up.body, req_id),
                    ));
                }
                if attempt < state.max_retries as usize && upstream::is_retryable(up.status, &up.body) {
                    continue;
                }
                // 对外状态码归一化（external_status）：上游撒谎档映射到 Anthropic 语义
                // 等价类，其余（429/400/5xx/0）透传原始状态码
                let (ext_status, ext_typ) =
                    external_status(up.status).unwrap_or((up.status, "upstream_error"));
                return Err((
                    StatusCode::from_u16(ext_status).unwrap_or(StatusCode::BAD_GATEWAY),
                    upstream_error_body(ext_typ, &up.body, req_id),
                ));
            }
        }
    }
    unreachable!("retry loop always returns")
}

fn api_error(typ: &str, msg: &str) -> Json<Value> {
    Json(json!({ "error": { "type": typ, "message": msg } }))
}

/// 带 req_id 的错误响应：客户端报错时引用此 ID 即可对到日志
fn api_error_id(typ: &str, msg: &str, req_id: &str) -> Json<Value> {
    Json(json!({ "error": { "type": typ, "message": msg, "req_id": req_id } }))
}

/// 对外状态码归一化：客户端是 Anthropic SDK，按 HTTP 状态码归类重试与报错文案，
/// 上游原始状态透传会撒三类谎——
/// - 2xx/3xx（1005 额度耗尽骑 200，11-04 实锤）：对外 200 会让客户端把 error JSON
///   当成功响应体解析（Claude Code 表现「流提前结束」，11-02 挂账）→ 429
///   rate_limit_error，客户端退避重试；池已冷却该号，重试换号可成
/// - 401/403（上游号 token 死/权限不足）：透传会让客户端误判自己鉴权失败
///   （Claude Code 触发重新登录提示）→ 503 api_error，瞬时语义，重试换号即可
/// - 405（WAF 风控）：对外是「方法错」谎言 → 529 overloaded_error（Anthropic 官方
///   容量档，SDK 原生识别），客户端指数退避，正好等全局退避过期
/// 其余（429/400/413/5xx/0）语义本就成立，返回 None 由调用方透传。
fn external_status(status: u16) -> Option<(u16, &'static str)> {
    match status {
        200..=399 => Some((429, "rate_limit_error")),
        401 | 403 => Some((503, "api_error")),
        405 => Some((529, "overloaded_error")),
        _ => None,
    }
}

/// 对外 error 体字段提取：上游 body 是 JSON 时取业务 code（顶层优先，其次 error 内层，
/// 字符串数字也收）与 msg/message 正文；非 JSON（WAF HTML 页等）message 原样透出、
/// 无 code——body 捕获侧（upstream.rs messages_stream）已限 4096 字，这里不再截。
/// 口径与 upstream.rs body_code 对齐——那边是私有实现且该文件不在本线改动范围
/// （另一会话未提交），这里自带轻量版。
fn external_error_fields(body: &str) -> (Option<i64>, String) {
    let trimmed = body.trim();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return (None, trimmed.to_string());
    };
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| v.get(*k))
            .or_else(|| v.get("error").and_then(|e| keys.iter().find_map(|k| e.get(*k))))
    };
    let code = pick(&["code"])
        .and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(|s| s.parse::<i64>().ok())));
    let msg = pick(&["msg", "message"])
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty());
    (code, msg.unwrap_or_else(|| trimmed.to_string()))
}

/// 上游错误 → 对外 error 体：type 由调用方定（external_status 归一化档或透传档），
/// message 取上游 body 的 msg/message 正文（不再整段塞原始 JSON），业务 code 随
/// error 对象透出——SDK 按状态码与 type 归类，多余字段忽略。
fn upstream_error_body(typ: &str, up_body: &str, req_id: &str) -> Json<Value> {
    let (code, message) = external_error_fields(up_body);
    let mut body = api_error_id(typ, &message, req_id);
    if let Some(c) = code {
        body.0["error"]["code"] = json!(c);
    }
    body
}

/// /v1/responses（M4/M5）：OpenAI Responses 入站 → anthropic 上游。
/// 非流式：上游 SSE 聚合为 response 对象；流式：装配 Responses 事件流
/// （created → output_text.delta / function_call → output_item.done → completed）。
async fn responses_endpoint(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    // 请求关联 ID：换号重试产生的多条日志共用；错误响应体回传供客户端对账
    let req_id = uuid::Uuid::new_v4().simple().to_string();
    // 调用方标识：截断入日志（ZCode / Claude Code / curl 等 UA 各异），区分请求来源
    let ua: String = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(120).collect())
        .unwrap_or_default();
    let req: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string())))?;
    let model = super::translate::map_model(get_str_req(&req, "model"));
    let stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let session = session_of(&headers, &req);
    let sticky = session.as_deref().map_or(pool::Sticky::None, pool::Sticky::Session);
    let prepared = super::responses::responses_to_upstream(&req)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e)))?;
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let req_preview = clip(&String::from_utf8_lossy(&body), LOG_REQ_CAP);
    if !stream {
        let ok = pool_send(&state, &prepared, "/v1/responses", &model, false, &req_preview, &req_id, sticky).await?;
        let bytes = match ok.reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let out = super::responses::aggregate_sse_to_responses(&raw, &model);
        ok.settle.settle_success();
        push_ok_log(&state.shared, "/v1/responses", &ok.account, ok.started.elapsed().as_millis() as u64, ok.ttft_ms, ok.attempt, &model, false, &req_id, &ua, &req_preview, false, Some(clip(&out.to_string(), LOG_RESP_CAP)));
        return Ok(Json(out).into_response());
    }
    let ok = pool_send(&state, &prepared, "/v1/responses", &model, true, &req_preview, &req_id, sticky).await?;
    let UpstreamOk { reply, account, attempt, ttft_ms, started, req_id, settle } = ok;
    let resp = match reply {
        UpstreamReply::Stream(r) => r,
    };
    let shared = std::sync::Arc::clone(&state.shared);
    let keepalive = state.keepalive_secs;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut stream = super::responses::ResponsesStream::new(&model);
        let mut resp = resp;
        let pre = stream.take_pending();
        let mut acc = pre.clone(); // 下游帧累积（截断入日志）
        if tx.send(Ok(bytes::Bytes::from(pre))).await.is_err() {
            return; // 客户端断开
        }
        // SSE keepalive：与前两个端点同款
        // 截断检测：与前两个端点同款——上游（Anthropic SSE）必须含 message_stop，
        // 否则发 Responses 式 error 事件再收尾（finish() 原样会谎报 completed）
        let mut saw_stop = false;
        let mut idle = tokio::time::interval(std::time::Duration::from_secs(keepalive.max(1)));
        idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        idle.tick().await;
        let alive = keepalive > 0;
        loop {
            let chunk = if alive {
                tokio::select! {
                    c = resp.chunk() => c,
                    _ = idle.tick() => {
                        if tx.send(Ok(bytes::Bytes::from_static(b": ping\n\n"))).await.is_err() {
                            break;
                        }
                        continue;
                    }
                }
            } else {
                resp.chunk().await
            };
            match chunk {
                Ok(Some(c)) => {
                    if !saw_stop && c.windows(12).any(|w| w == b"message_stop") {
                        saw_stop = true;
                    }
                    let out = stream.feed(&String::from_utf8_lossy(&c));
                    if acc.chars().count() < LOG_RESP_CAP {
                        acc.push_str(&out);
                    }
                    if !out.is_empty() && tx.send(Ok(bytes::Bytes::from(out))).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break;
                }
            }
        }
        let truncated = !saw_stop;
        if truncated {
            const TRUNC_EVENT: &str = "event: error\ndata: {\"type\":\"error\",\"code\":\"overloaded_error\",\"message\":\"upstream stream ended before message_stop (zcode-hub gateway)\"}\n\n";
            let _ = tx.send(Ok(bytes::Bytes::from_static(TRUNC_EVENT.as_bytes()))).await;
            if acc.chars().count() < LOG_RESP_CAP {
                acc.push_str(TRUNC_EVENT);
            }
        }
        let fin = stream.finish();
        if acc.chars().count() < LOG_RESP_CAP {
            acc.push_str(&fin);
        }
        let _ = tx.send(Ok(bytes::Bytes::from(fin))).await;
        settle.settle_success();
        push_ok_log(&shared, "/v1/responses", &account, started.elapsed().as_millis() as u64, ttft_ms, attempt, &model, true, &req_id, &ua, &req_preview, truncated, Some(clip(&acc, LOG_RESP_CAP)));
    });
    let mut resp = Response::new(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    Ok(resp)
}

fn get_str_req<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对外状态码归一化：客户端按状态码归类重试与报错，上游撒谎档透传会误导客户端
    #[test]
    fn external_status_maps_lies_to_honest_classes() {
        // 200 包业务错（1005 额度耗尽实锤）：对外必须非 2xx，否则客户端把 error JSON
        // 当成功响应体解析（Claude Code「流提前结束」的根因）
        assert_eq!(external_status(200), Some((429, "rate_limit_error")));
        // 上游号 401/403 ≠ 客户端鉴权失败，透传会触发客户端重新登录提示
        assert_eq!(external_status(401), Some((503, "api_error")));
        assert_eq!(external_status(403), Some((503, "api_error")));
        // 风控不是方法错
        assert_eq!(external_status(405), Some((529, "overloaded_error")));
        // 语义本就成立的透传
        assert_eq!(external_status(0), None);
        assert_eq!(external_status(429), None);
        assert_eq!(external_status(502), None);
        // 529 非 IANA 注册码：http crate 接受 100..=999，钉住这个前提
        assert!(StatusCode::from_u16(529).is_ok());
    }

    /// 对外 error 体：message 取上游 msg/message 正文，业务 code 随 error 对象透出
    #[test]
    fn error_body_surfaces_upstream_code_and_msg() {
        let (code, msg) = external_error_fields(
            r#"{"code":1005,"msg":"exceed quota limit","logid":"2026110803012724a1e2abbaf1a20f6b92"}"#,
        );
        assert_eq!(code, Some(1005));
        assert_eq!(msg, "exceed quota limit");
        // error 内层形态
        let (code, msg) = external_error_fields(r#"{"error":{"code":3004,"message":"flow expired"}}"#);
        assert_eq!(code, Some(3004));
        assert_eq!(msg, "flow expired");
        // 非 JSON（WAF HTML 页）原样透出（不截），无 code
        let html = format!("<html>blocked by WAF{}</html>", "x".repeat(300));
        let (code, msg) = external_error_fields(&html);
        assert_eq!(code, None);
        assert_eq!(msg, html);
        // 组装出口：type 过归一化档、code 带入 error 对象
        let body = upstream_error_body(
            "rate_limit_error",
            r#"{"code":1005,"msg":"exceed quota limit"}"#,
            "req123",
        );
        assert_eq!(body.0["error"]["type"], "rate_limit_error");
        assert_eq!(body.0["error"]["code"], 1005);
        assert_eq!(body.0["error"]["message"], "exceed quota limit");
        assert_eq!(body.0["error"]["req_id"], "req123");
    }
}
