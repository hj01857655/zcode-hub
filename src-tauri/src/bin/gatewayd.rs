// GATEWAY 无头启动入口：不经 Tauri UI 直接起 axum 服务（e2e 验收 / 服务器部署用）。
// 端口与 api_key 读 gateway.json 配置；可用 ZCODE_GATEWAY_PORT / ZCODE_GATEWAY_API_KEY 覆盖。
fn main() {
    let mut cfg = zcode_hub_lib::gateway::config::GatewayConfig::load();
    let port = std::env::var("ZCODE_GATEWAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(cfg.port);
    let api_key = std::env::var("ZCODE_GATEWAY_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.api_key.clone());
    if api_key.is_empty() {
        eprintln!("[gatewayd] api_key 为空：服务会拒绝所有请求；请先在 UI 配置或设 ZCODE_GATEWAY_API_KEY");
    }
    cfg.api_key = api_key;
    cfg.port = port;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let shared = std::sync::Arc::new(zcode_hub_lib::gateway::GatewayShared {
        log: std::sync::Mutex::new(Vec::new()),
        pool: zcode_hub_lib::gateway::pool::Pool::new(),
        models: std::sync::Mutex::new(
            zcode_hub_lib::gateway::MODEL_LIST
                .iter()
                .map(|s| s.to_string())
                .collect(),
        ),
        model_faces: std::sync::Mutex::new(std::collections::HashMap::new()),
        // 代理池从磁盘 proxy 键装配（与账号管理同源），mode=off → None（完全直连）
        proxies: std::sync::Mutex::new(zcode_hub_lib::gateway::proxy::ProxyPool::from_disk(cfg.upstream_connect_secs)),
    });
    // sender 必须活到 block_on 返回：全部掉线会立即触发 graceful shutdown（实测进程秒退）
    let (tx, rx) = tokio::sync::watch::channel(false);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("gatewayd tokio runtime");
    eprintln!("[gatewayd] starting on {addr}");
    rt.block_on(zcode_hub_lib::gateway::server::serve(addr, cfg, rx, shared));
    drop(tx);
}
