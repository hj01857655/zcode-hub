//! 出网代理池：账号↔IP 粘性绑定 + 风控迁移 + 健康计分（对齐 ZCode2api-go proxy.go 语义）。
//!
//! 设计约束（对齐调度层错误分档）：
//! - ZCode WAF 按 IP+指纹分档（405/3012=IP 级风控，3009/3010=IP 级并发档），
//!   账号在多 IP 间跳本身是风控信号 → 账号↔IP 粘性绑定，不按请求轮转
//! - IP 被标脏（on_risk）时账号迁往新出口，绝不回落直连脏出口；
//!   脏出口进冷却窗口（risk_backoff_secs），期满凭负分留在池里靠成功回血
//! - 3008/1005/401 与 IP 无关，健康分不动
//! - 全部出口死透时整池复位（二次机会）：全池不可用比脏 IP 更伤可用性

use super::config::GatewayConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 出口状态快照（凭据脱敏；gateway_status / 调试用）。
#[derive(Debug, Serialize)]
pub struct ProxyStat {
    pub url: String,
    pub score: i32,
    pub cooling: bool,
    pub bindings: usize,
}

struct ProxyEntry {
    url: String,
    client: reqwest::Client,
}

struct Inner {
    entries: Vec<ProxyEntry>,
    bindings: HashMap<String, String>, // member_id → proxy url
    scores: HashMap<String, i32>,
    cool: HashMap<String, Instant>,
    min_score: i32,
    sticky: bool,
    rotate: bool,
    risk_cool: Duration,
}

/// 出网代理池。`None` 实例语义由 `Option<ProxyPool>` 承载（mode=off 不装配）。
pub struct ProxyPool {
    inner: Mutex<Inner>,
}

impl ProxyPool {
    /// 从网关配置装配；mode 无效或列表为空返回 None（调用方保持直连）。
    pub fn from_config(cfg: &GatewayConfig) -> Option<ProxyPool> {
        let p = &cfg.proxy;
        let urls: Vec<String> = match p.mode.as_str() {
            "single" => {
                if p.single.is_empty() {
                    Vec::new()
                } else {
                    vec![p.single.clone()]
                }
            }
            "pool" => p.proxies.iter().filter(|u| !u.is_empty()).cloned().collect(),
            _ => Vec::new(), // off / 未配置
        };
        if urls.is_empty() {
            return None;
        }
        let d_true = |b: &Option<bool>| b.map(|v| v).unwrap_or(true);
        let min_score = p.min_score.unwrap_or(-2);
        let risk_cool = Duration::from_secs(p.risk_backoff_secs.filter(|v| *v > 0).unwrap_or(45));
        let mut entries = Vec::new();
        for u in urls {
            match proxy_client(&u, cfg.upstream_connect_secs) {
                Ok(c) => entries.push(ProxyEntry { url: u, client: c }),
                Err(e) => eprintln!("[proxy] 代理串无效已跳过: {} ({e})", mask_proxy(&u)),
            }
        }
        if entries.is_empty() {
            eprintln!("[proxy] 没有任何有效代理串，保持直连");
            return None;
        }
        eprintln!(
            "[proxy] 池就绪：{} 条出口（mode={}，粘性={}，风控迁移={}，脏口冷却={:?}，min_score={min_score}）",
            entries.len(),
            p.mode,
            d_true(&p.sticky_per_account),
            d_true(&p.rotate_on_risk),
            risk_cool,
        );
        Some(ProxyPool {
            inner: Mutex::new(Inner {
                entries,
                bindings: HashMap::new(),
                scores: HashMap::new(),
                cool: HashMap::new(),
                min_score,
                sticky: d_true(&p.sticky_per_account),
                rotate: d_true(&p.rotate_on_risk),
                risk_cool,
            }),
        })
    }

    /// 按账号取粘性出口：已有绑定且出口可用 → 返回；无绑定/绑定死/冷却中 →
    /// 重新分配（绑定数最少优先）。全部死透 → 整池复位二次机会。
    /// None = 池内无可分配出口（调用方回落基础客户端直连）。
    pub fn client_for(&self, member_id: &str) -> Option<reqwest::Client> {
        let mut inner = self.inner.lock().ok()?;
        // 出口快照收 owned（url+client）：MutexGuard 经 Deref 不分裂字段借用，
        // 持 &ProxyEntry 期间无法 mutate bindings
        let mut alive_urls: Vec<(String, reqwest::Client)> = Self::alive(&inner)
            .into_iter()
            .map(|e| (e.url.clone(), e.client.clone()))
            .collect();
        if alive_urls.is_empty() {
            Self::reset(&mut inner);
            alive_urls = Self::alive(&inner)
                .into_iter()
                .map(|e| (e.url.clone(), e.client.clone()))
                .collect();
        }
        // 粘性：已有绑定且出口可用 → 直接复用（账号不跳 IP）
        if inner.sticky {
            if let Some(u) = inner.bindings.get(member_id).cloned() {
                if !Self::dead(&inner, &u) && !Self::cooling(&inner, &u) {
                    if let Some(e) = inner.entries.iter().find(|e| e.url == u) {
                        return Some(e.client.clone());
                    }
                }
            }
        }
        // 走到这里必然重新分配：无绑定 / 绑定死 / 冷却中 / 粘性关闭
        inner.bindings.remove(member_id);
        let mut best: Option<(String, reqwest::Client)> = None;
        let mut best_n = usize::MAX;
        for (u, c) in &alive_urls {
            let n = Self::bind_count(&inner, u);
            if n < best_n {
                best = Some((u.clone(), c.clone()));
                best_n = n;
            }
        }
        let (u, c) = best?;
        inner.bindings.insert(member_id.to_string(), u.clone());
        eprintln!(
            "[proxy] 账号 {member_id} → 出口 {}（在池 {}/{}）",
            mask_proxy(&u),
            alive_urls.len(),
            inner.entries.len()
        );
        Some(c)
    }

    /// IP 级风控（405/3012）：当前出口负分 + 进冷却窗口；迁移开启时该出口上
    /// 全部账号解绑（下次请求落新出口）。触底（≤min_score）踢出轮转。
    pub fn on_risk(&self, member_id: &str) {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(u) = inner.bindings.get(member_id).cloned() else {
            return;
        };
        *inner.scores.entry(u.clone()).or_insert(0) -= 1;
        // 先提升字段值到局部：MutexGuard 上同语句混用可变/不可变借用会撞 E0502
        let score = inner.scores[&u];
        let risk_cool = inner.risk_cool;
        if score <= inner.min_score {
            // 触底踢出：dead 由分数判定，无需冷却项；关联账号全部迁移
            Self::unbind_all(&mut inner, &u);
            eprintln!("[proxy] 出口 {} 触底踢出（score={score}），关联账号全部迁移", mask_proxy(&u));
            return;
        }
        inner.cool.insert(u.clone(), Instant::now() + risk_cool);
        if inner.rotate {
            Self::unbind_all(&mut inner, &u);
        }
        eprintln!(
            "[proxy] 出口 {} 撞 IP 级风控，冷却 {risk_cool:?}（score={score}，绑定账号已迁移）",
            mask_proxy(&u)
        );
    }

    /// IP 级并发档（3009/3010）：出口负分，账号不迁移（瞬时负载，非脏）。
    pub fn on_ip_conc(&self, member_id: &str) {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(u) = inner.bindings.get(member_id).cloned() {
            let s = inner.scores.entry(u.clone()).or_insert(0);
            *s -= 1;
            if *s < 0 {
                eprintln!("[proxy] 出口 {} 并发档负分 {s}", mask_proxy(&u));
            }
        }
    }

    /// 请求成功：出口负分回血（正分封顶 0，负分黏性保留）。
    pub fn mark_ok(&self, member_id: &str) {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(u) = inner.bindings.get(member_id).cloned() {
            let s = inner.scores.entry(u.clone()).or_insert(0);
            if *s < 0 {
                *s += 1;
            }
        }
    }

    /// 风控迁移后的全局退避建议值（秒）；0 = 调用方维持原时长。
    pub fn risk_backoff_secs(&self) -> u64 {
        self.inner.lock().map(|g| g.risk_cool.as_secs()).unwrap_or(0)
    }

    /// 存活出口数（未死未冷却）。
    pub fn size(&self) -> usize {
        self.inner.lock().map(|g| Self::alive(&g).len()).unwrap_or(0)
    }

    /// 出口状态快照（凭据脱敏）。
    pub fn status(&self) -> Vec<ProxyStat> {
        let Some(inner) = self.inner.lock().ok() else { return Vec::new() };
        inner
            .entries
            .iter()
            .map(|e| ProxyStat {
                url: mask_proxy(&e.url),
                score: inner.scores.get(&e.url).copied().unwrap_or(0),
                cooling: Self::dead(&inner, &e.url) || Self::cooling(&inner, &e.url),
                bindings: Self::bind_count(&inner, &e.url),
            })
            .collect()
    }

    // ---- 内部 ----

    fn alive(inner: &Inner) -> Vec<&ProxyEntry> {
        inner
            .entries
            .iter()
            .filter(|e| !Self::dead(inner, &e.url) && !Self::cooling(inner, &e.url))
            .collect()
    }

    fn dead(inner: &Inner, url: &str) -> bool {
        inner.scores.get(url).copied().unwrap_or(0) <= inner.min_score
    }

    fn cooling(inner: &Inner, url: &str) -> bool {
        inner.cool.get(url).map(|t| Instant::now() < *t).unwrap_or(false)
    }

    fn bind_count(inner: &Inner, url: &str) -> usize {
        inner.bindings.values().filter(|b| b.as_str() == url).count()
    }

    fn unbind_all(inner: &mut Inner, url: &str) {
        inner.bindings.retain(|_, v| v != url);
    }

    /// 整池复位：清负分/冷却（二次机会），绑定保留——出口回来了账号还粘在
    /// 原口上，不产生额外跳 IP 信号。
    fn reset(inner: &mut Inner) {
        for s in inner.scores.values_mut() {
            *s = 0;
        }
        inner.cool.clear();
        eprintln!("[proxy] 全部出口不可用，整池复位二次机会（绑定保留）");
    }
}

/// 每条出口独立 Client：连接复用按代理天然隔离（keepalive 连接绑定在各自
/// 构建的连接池上，互不串台）。socks5 需要 reqwest `socks` feature。
fn proxy_client(proxy_url: &str, connect_secs: u64) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_secs.max(1)))
        .proxy(reqwest::Proxy::all(proxy_url)?)
        .build()
}

/// 日志脱敏：隐藏 user:pass（scheme://u:p@host:port → scheme://host:port）。
fn mask_proxy(proxy_url: &str) -> String {
    if let Some(at) = proxy_url.rfind('@') {
        if let Some(scheme_end) = proxy_url.find("://") {
            return format!("{}{}", &proxy_url[..scheme_end + 3], &proxy_url[at + 1..]);
        }
    }
    proxy_url.to_string()
}

#[cfg(test)]
mod tests {
    use crate::gateway::config::ProxyConfig;
    use super::*;

    fn pool(urls: &[&str], min_score: i32) -> ProxyPool {
        let cfg = GatewayConfig {
            proxy: ProxyConfig {
                mode: "pool".into(),
                single: String::new(),
                proxies: urls.iter().map(|s| s.to_string()).collect(),
                sticky_per_account: Some(true),
                rotate_on_risk: Some(true),
                risk_backoff_secs: Some(45),
                min_score: Some(min_score),
            },
            ..Default::default()
        };
        ProxyPool::from_config(&cfg).expect("池装配失败")
    }

    #[test]
    fn sticky_binding_holds_and_spreads() {
        let p = pool(&["http://u:p@10.0.0.1:3129", "http://u:p@10.0.0.2:3129", "http://u:p@10.0.0.3:3129"], -2);
        for _ in 0..5 {
            assert!(p.client_for("acc-a").is_some(), "粘性绑定不应失手");
        }
        for acc in ["b", "c", "d"] {
            assert!(p.client_for(acc).is_some());
        }
        // 粘性 + 均衡：4 账号摊在 3 出口上，绑定总数 = 4，单口最多 2
        let st = p.status();
        let total: usize = st.iter().map(|s| s.bindings).sum();
        assert_eq!(total, 4, "绑定总数应等于账号数");
        assert!(st.iter().all(|s| s.bindings <= 2), "最少绑定均衡被破坏: {st:?}");
    }

    #[test]
    fn on_risk_migrates_and_cools() {
        let p = pool(&["http://u:p@10.0.0.1:3129", "http://u:p@10.0.0.2:3129"], -2);
        assert!(p.client_for("acc-a").is_some());
        p.on_risk("acc-a");
        // 原出口进冷却且绑定清空；账号迁移后落到另一条活口
        let st = p.status();
        let cooled: Vec<_> = st.iter().filter(|s| s.cooling).collect();
        assert_eq!(cooled.len(), 1, "原出口应进冷却");
        assert_eq!(cooled[0].bindings, 0, "冷却出口绑定应已清空");
        assert_eq!(p.size(), 1, "冷却期只剩另一条可用");
        assert!(p.client_for("acc-a").is_some(), "迁移后应能取到新出口");
    }

    #[test]
    fn on_ip_conc_stays() {
        let p = pool(&["http://u:p@10.0.0.1:3129", "http://u:p@10.0.0.2:3129"], -2);
        assert!(p.client_for("acc-a").is_some());
        p.on_ip_conc("acc-a");
        assert!(p.client_for("acc-a").is_some());
        assert_eq!(p.status().iter().filter(|s| s.cooling).count(), 0, "并发档不进冷却");
    }

    #[test]
    fn all_dead_resets_second_chance() {
        let p = pool(&["http://u:p@10.0.0.1:3129"], -1);
        p.client_for("acc-a");
        p.on_risk("acc-a");
        p.client_for("acc-a");
        p.on_risk("acc-a"); // 触底（min_score=-1）
        assert!(p.client_for("acc-a").is_some(), "全死应整池复位，而非无口可用");
    }

    #[test]
    fn mark_ok_recovers_but_caps_at_zero() {
        let p = pool(&["http://u:p@10.0.0.1:3129", "http://u:p@10.0.0.2:3129"], -2);
        p.client_for("acc-a");
        p.on_ip_conc("acc-a");
        p.mark_ok("acc-a");
        assert!(p.status().iter().all(|s| s.score <= 0), "正分封顶 0");
    }

    #[test]
    fn off_and_empty_configs_yield_none() {
        let base = GatewayConfig::default();
        assert!(ProxyPool::from_config(&base).is_none(), "mode 缺省 = off");
        let mut single_empty = base.clone();
        single_empty.proxy.mode = "single".into();
        assert!(ProxyPool::from_config(&single_empty).is_none(), "single 空串 = off");
        let mut pool_empty = base.clone();
        pool_empty.proxy.mode = "pool".into();
        assert!(ProxyPool::from_config(&pool_empty).is_none(), "空池 = off");
    }

    #[test]
    fn cooldown_expiry_returns_entry() {
        let p = pool(&["http://u:p@10.0.0.1:3129", "http://u:p@10.0.0.2:3129"], -2);
        p.client_for("acc-a");
        p.on_risk("acc-a");
        {
            let mut inner = p.inner.lock().unwrap();
            for t in inner.cool.values_mut() {
                *t = Instant::now() - Duration::from_secs(1);
            }
        }
        assert!(p.client_for("acc-b").is_some(), "冷却到期应恢复可用");
    }
}
