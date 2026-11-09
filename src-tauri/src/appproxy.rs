//! 应用级出网代理：全局唯一 ProxyPool 实例 + 用途开关。
//!
//! 配置面在 gateway.json 的 `proxy` 键（历史存储位置不动，配置原地升级）；
//! 池实例挂 Tauri State，网关转发与账号管理（claim/deploy/oauth/quota/referral）
//! 共用：同一账号在两侧粘同一 IP，绑定/计分/冷却全局一致。
//! scope 开关在 ProxyConfig.scopes（gateway/claim/deploy/oauth 默认全开）。
use crate::gateway::config::{load_app_proxy, save_app_proxy, ProxyConfig};
use crate::gateway::proxy::ProxyPool;
use std::sync::Mutex;

pub struct AppProxy {
    pub cfg: Mutex<ProxyConfig>,
    pub pool: Mutex<Option<ProxyPool>>,
}

impl AppProxy {
    pub fn new() -> Self {
        let cfg = load_app_proxy();
        let pool = ProxyPool::from_parts(&cfg, 15);
        Self {
            cfg: Mutex::new(cfg),
            pool: Mutex::new(pool),
        }
    }

    /// 保存配置并整池重建（UI 保存后立即生效，不等网关重启）。
    pub fn save(&self, cfg: ProxyConfig) -> Result<(), String> {
        save_app_proxy(&cfg)?;
        let pool = ProxyPool::from_parts(&cfg, 15);
        *self.cfg.lock().map_err(|e| e.to_string())? = cfg;
        *self.pool.lock().map_err(|e| e.to_string())? = pool;
        Ok(())
    }

    /// 按用途取出口：mode=off / 该用途关 / 池空 → None（调用方直连）。
    /// member_id = 账号 id（粘性键，跨用途一致）。
    pub fn agent_for(&self, scope: &str, member_id: &str) -> Option<ureq::Agent> {
        let cfg = self.cfg.lock().ok()?;
        if cfg.mode.is_empty() || cfg.mode == "off" || !cfg.scope_enabled(scope) {
            return None;
        }
        drop(cfg);
        let px = self.pool.lock().ok()?;
        px.as_ref()?.agent_for(member_id)
    }

    /// reqwest 版（网关转发专用路径，保持原 client_for 语义）。
    pub fn client_for(&self, member_id: &str) -> Option<reqwest::Client> {
        let cfg = self.cfg.lock().ok()?;
        if cfg.mode.is_empty() || cfg.mode == "off" {
            return None;
        }
        drop(cfg);
        let px = self.pool.lock().ok()?;
        px.as_ref()?.client_for(member_id)
    }

    /// IP 级风控上报（账号管理侧调用点：claim/deploy 撞 405/3012 时）。
    pub fn on_risk(&self, member_id: &str) {
        if let Ok(px) = self.pool.lock() {
            if let Some(p) = px.as_ref() {
                p.on_risk(member_id);
            }
        }
    }

    /// 运行态快照（设置页展示）：配置回显 + 出口健康。
    pub fn status(&self) -> serde_json::Value {
        let cfg = self.cfg.lock().ok();
        let cfg = cfg.as_deref();
        let stats = self
            .pool
            .lock()
            .ok()
            .and_then(|px| px.as_ref().map(|p| p.status()))
            .unwrap_or_default();
        serde_json::json!({
            "mode": cfg.map(|c| c.mode.as_str()).unwrap_or("off"),
            "single": cfg.map(|c| c.single.clone()).unwrap_or_default(),
            "proxies": cfg.map(|c| c.proxies.clone()).unwrap_or_default(),
            "sticky": cfg.map(|c| c.sticky_per_account.unwrap_or(true)).unwrap_or(true),
            "rotate": cfg.map(|c| c.rotate_on_risk.unwrap_or(true)).unwrap_or(true),
            "riskBackoffSecs": cfg.map(|c| c.risk_backoff_secs.unwrap_or(45)).unwrap_or(45),
            "minScore": cfg.map(|c| c.min_score.unwrap_or(-2)).unwrap_or(-2),
            "scopes": cfg.map(|c| c.scopes.clone()).unwrap_or_default(),
            "stats": stats,
        })
    }
}

impl Default for AppProxy {
    fn default() -> Self {
        Self::new()
    }
}
