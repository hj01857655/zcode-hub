// GATEWAY — OpenAI/Anthropic 兼容反代（M1：服务骨架 + models + 鉴权 + health）
// 设计见 docs/GATEWAY.md。服务独立于窗口生命周期，托盘模式照常运行。
pub mod config;
pub mod openai;
pub mod pool;
pub mod responses;
pub mod server;
pub mod translate;
pub mod upstream;

/// 跨线程共享的网关运行态：pool 快照（池成员/冷却/计数）+ 最近请求日志环。
/// SvcState 持一份 Arc，twoapi_status 命令经 TwoApiState 持另一份 Arc 读取。
pub struct GatewayShared {
    pub log: Mutex<Vec<serde_json::Value>>,
    /// pool 调度器：SvcState 与 twoapi_status 共用同一实例（计数/冷却/游标全局一致）
    pub pool: pool::Pool,
    /// 动态模型面（/v1/models 聚合结果；gateway_status 同源读取）。
    /// 初始为静态 MODEL_LIST，聚合成功后被 entitlements 并集覆盖。
    pub models: Mutex<Vec<String>>,
    /// per-account 模型面镜像（server.rs ensure_model_faces 回写），供 gateway_status 拼进池成员。
    /// id → None=拉取失败/未拉取（未知），Some(空)=确认无桶，Some(list)=确认模型集
    pub model_faces: Mutex<std::collections::HashMap<String, Option<Vec<String>>>>,
}
impl GatewayShared {
    pub fn model_list(&self) -> Vec<String> {
        self.models.lock().map(|v| v.clone()).unwrap_or_default()
    }
    pub fn push_log(&self, entry: serde_json::Value) {
        if let Ok(mut v) = self.log.lock() {
            v.push(entry.clone());
            let n = v.len();
            if n > LOG_CAP {
                v.drain(0..n - LOG_CAP);
            }
        }
        // 落盘受配置开关控制；超限轮转（gateway.jsonl → gateway.jsonl.1，单份历史）
        let cfg = crate::gateway::config::GatewayConfig::load();
        if cfg.log_to_disk {
            Self::append_log_file(&entry, cfg.log_file_max_mb);
        }
    }
    pub fn logs(&self) -> Vec<serde_json::Value> {
        self.log.lock().map(|v| v.clone()).unwrap_or_default()
    }

    /// 日志落盘：gateway.jsonl 追加（重启不丢）；超 max_mb 轮转一份历史
    fn append_log_file(entry: &serde_json::Value, max_mb: u64) {
        use std::io::Write;
        let p = crate::Paths::detect().store_dir().join("gateway.jsonl");
        // 轮转检查：现文件超限即改名 .1（旧历史直接覆盖，只保一份）
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() > max_mb * 1024 * 1024 {
                let bak = crate::Paths::detect().store_dir().join("gateway.jsonl.1");
                let _ = std::fs::rename(&p, &bak);
            }
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = writeln!(f, "{entry}");
        }
    }
    pub fn load_log_file() -> Vec<serde_json::Value> {
        let p = crate::Paths::detect().store_dir().join("gateway.jsonl");
        let Ok(s) = std::fs::read_to_string(&p) else { return Vec::new() };
        let lines: Vec<&str> = s.lines().collect();
        let start = lines.len().saturating_sub(LOG_CAP);
        lines[start..].iter().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }
    /// 池快照（成员/冷却/计数），gateway_status 消费
    pub fn snapshot(&self, members: &[pool::PoolMember]) -> serde_json::Value {
        self.pool.snapshot(members)
    }

    /// 号级模型面只读快照，gateway_status 拼进池成员
    pub fn model_faces(&self) -> std::collections::HashMap<String, Option<Vec<String>>> {
        self.model_faces.lock().map(|v| v.clone()).unwrap_or_default()
    }
}
pub const LOG_CAP: usize = 200;

/// /v1/models 对外模型表：单一来源，server.rs 路由与 gateway_status 共用。
/// 与套餐 entitlements.capabilities 实测一致（glm-5.3 / glm-5.3-flash，billing/balance 实测）。
pub const MODEL_LIST: &[&str] = &["GLM-5.3-Flash", "GLM-5.3"];

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 服务运行状态：running 标志 + 句柄线程（M2 起扩展 uptime/计数）
pub struct GatewayState {
    pub running: AtomicBool,
    pub config: Mutex<config::GatewayConfig>,
    shutdown: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// 跨线程共享：请求日志环 + pool 计数（SvcState 写，twoapi_status 读）
    pub shared: std::sync::Arc<GatewayShared>,
}

impl GatewayState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            config: Mutex::new(config::GatewayConfig::load()),
            shutdown: Mutex::new(None),
            shared: std::sync::Arc::new(GatewayShared {
                // 启动时从 gateway.jsonl 读回尾部，重启不丢日志
                log: Mutex::new(GatewayShared::load_log_file()),
                pool: pool::Pool::new(),
                models: Mutex::new(MODEL_LIST.iter().map(|s| s.to_string()).collect()),
                model_faces: Mutex::new(std::collections::HashMap::new()),
            }),
        }
    }

    /// 启动服务：起独立 tokio runtime 线程，返回是否新启动（已在跑则 false）
    pub fn start(&self) -> Result<bool, String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let cfg = {
            let mut c = self.config.lock().map_err(|e| e.to_string())?;
            // 记住启用状态：应用（含 dev 重编）下次启动自动恢复
            c.auto_start = true;
            c.save()?;
            c.clone()
        };

        let (tx, rx) = tokio::sync::watch::channel(false);
        {
            let mut g = self.shutdown.lock().map_err(|e| e.to_string())?;
            *g = Some(tx);
        }

        let addr: SocketAddr = ([127, 0, 0, 1], cfg.port)
            .try_into()
            .map_err(|e| format!("bad port {}: {e}", cfg.port))?;
        let svc_cfg = cfg.clone();
        let shared = std::sync::Arc::clone(&self.shared);
        let running = &self.running;

        std::thread::Builder::new()
            .name("gateway".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("gateway tokio runtime");
                rt.block_on(async move {
                    server::serve(addr, svc_cfg, rx, shared).await;
                });
            })
            .map_err(|e| format!("spawn gateway thread: {e}"))?;

        // 端口绑定失败无法从线程同步回报，此处以短延迟后 running 标志判定
        running.store(true, Ordering::SeqCst);
        Ok(true)
    }

    /// 停止服务：广播 shutdown，等待标志清零
    pub fn stop(&self) -> Result<bool, String> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if let Some(tx) = self.shutdown.lock().map_err(|e| e.to_string())?.take() {
            let _ = tx.send(true);
        }
        self.running.store(false, Ordering::SeqCst);
        // 记住停用状态：下次应用启动不自动拉起
        if let Ok(mut c) = self.config.lock() {
            c.auto_start = false;
            if let Err(e) = c.save() {
                eprintln!("[gateway] 配置落盘失败: {e}");
            }
        }
        Ok(true)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}
