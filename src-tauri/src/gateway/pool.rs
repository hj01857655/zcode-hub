// GATEWAY 农场调度：账号库投影 + 粘性轮转 + 冷却 + 在飞上限 + 3012 全局退避。
// 设计见 docs/GATEWAY.md §3。调度状态纯内存（游标/冷却表重启清零），不落第二份盘。
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 单号在飞请求上限：多客户端挤同号会撞 3008/3009/3010 并发档
pub const MAX_INFLIGHT: u32 = 2;

/// 3012/405 全局退避：WAF 判的是 IP+指纹不是账号，单号冷却会让重放循环把整池指纹喂脏
pub const GLOBAL_BACKOFF_SECS: u64 = 10 * 60;

/// 会话 pin 空闲 TTL：超过该时长无请求即解钉（LiteLLM session affinity 同思路）
pub const SESSION_TTL_SECS: u64 = 30 * 60;
/// pin 表上限：防多客户端会话堆积，超限丢最旧一半
const SESSION_CAP: usize = 512;

/// 成功率熔断（one-api 80%/10 同思路）：最近 TRIP_WINDOW 次收尾里错误率 ≥ 80% 即认定
/// 该号持续故障，落 TRIP_COOLDOWN_SECS 长冷却（单次短冷却压不住的慢性错误：3007/5xx 连发）
const TRIP_WINDOW: usize = 10;
const TRIP_COOLDOWN_SECS: u64 = 10 * 60;

pub struct PoolMember {
    pub id: String,
    pub name: String,
    pub token: String,
    pub mid: Option<String>,
    /// 该号当前可用的模型名（小写）。None = 模型面未知（balance 拉取失败/尚未拉到），
    /// pick 时按万能号放行；Some(空) = 确认无任何模型桶，任何模型请求都不命中。
    /// 实测套餐间模型面不同：周卡含 GLM-5.3 + GLM-5.3-Flash，夜卡仅 GLM-5.3-Flash。
    pub models: Option<Vec<String>>,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Sticky<'a> {
    /// 无会话标识：走全局游标粘性
    None,
    /// 会话粘性：同 session 钉同号（多会话并发时互不冲掉上游 prompt cache）
    Session(&'a str),
}

#[derive(Default)]
struct Inner {
    /// 下一次 pick 的起点。粘性开：成功后停在被选中号上，失败后 +1（换号）；
    /// 粘性关（轮换）：成功也 +1，池内分摊
    cursor: usize,
    /// 账号粘性开关（配置面，serve 启动时写入）
    sticky: bool,
    inflight: HashMap<String, u32>,
    cool: HashMap<String, Instant>,
    global_until: Option<Instant>,
    /// session → (member_id, 最近命中)。会话亲和独立于全局粘性开关：带标识即钉
    sessions: HashMap<String, (String, Instant)>,
    /// 成功率熔断窗口：member_id → 最近 TRIP_WINDOW 次收尾结果（true=成功）
    hist: HashMap<String, VecDeque<bool>>,
    /// 连续失败熔断：member_id → 当前连续失败次数（成功清零；达到 allowed_fails 即长冷却）
    fail_streak: HashMap<String, u32>,
    /// 连续失败熔断阈值（配置面，serve 启动时写入；0 = 关闭）
    allowed_fails: u32,
    /// 累计请求计数（成功/失败，settle 落账）
    total_ok: u64,
    total_err: u64,
}

pub struct Pool(Mutex<Inner>);

impl Pool {
    pub fn new() -> Self {
        Self(Mutex::new(Inner { sticky: true, ..Default::default() }))
    }

    /// 粘性开关（配置面）：开 = 成功后驻留同号（吃上游 prompt cache 命中），关 = 每请求轮换分摊
    pub fn set_sticky(&self, v: bool) {
        if let Ok(mut inner) = self.0.lock() {
            inner.sticky = v;
        }
    }

    /// 连续失败熔断阈值（配置面）：同一账号连续失败 N 次即强制长冷却；0 = 关闭
    pub fn set_allowed_fails(&self, v: u32) {
        if let Ok(mut inner) = self.0.lock() {
            inner.allowed_fails = v;
        }
    }

    fn sweep(inner: &mut Inner) {
        let now = Instant::now();
        inner.cool.retain(|_, until| *until > now);
        if inner.global_until.is_some_and(|t| t <= now) {
            inner.global_until = None;
        }
        // 会话 pin 过期清理；仍超上限丢最旧一半（HashMap 无序，drain 随机近似最旧，够用）
        let ttl = Duration::from_secs(SESSION_TTL_SECS);
        inner.sessions.retain(|_, (_, seen)| now.duration_since(*seen) < ttl);
        if inner.sessions.len() > SESSION_CAP {
            let drop = inner.sessions.len() - SESSION_CAP / 2;
            let ids: Vec<String> = inner.sessions.keys().take(drop).cloned().collect();
            for id in ids {
                inner.sessions.remove(&id);
            }
        }
    }

    /// 选下一个可用号：跳过冷却中 / 在飞超限的成员，成功后 cursor 粘在被选号。
    /// 带 session：优先命中 pin 表里的号（可缓存亲和，独立于全局粘性开关），pin 失效才走游标。
    /// 返回 None = 全局退避中，或全员不可用（用 global_backoff_secs 区分）。
    pub fn pick(&self, members: &[PoolMember], sticky: Sticky<'_>, model: Option<&str>) -> Option<usize> {
        let mut inner = self.0.lock().ok()?;
        Self::sweep(&mut inner);
        if inner.global_until.is_some() {
            return None;
        }
        let n = members.len();
        if n == 0 {
            return None;
        }
        // 会话 pin 命中：号还在池、不在冷却、在飞未满才直接用；否则落回游标扫描并重新 pin
        if let Sticky::Session(sid) = sticky {
            if let Some(mid) = inner.sessions.get(sid).map(|(mid, _)| mid.clone()) {
                if let Some(idx) = members.iter().position(|m| m.id == mid) {
                    let m = &members[idx];
                    if !inner.cool.contains_key(&m.id)
                        && inner.inflight.get(&m.id).copied().unwrap_or(0) < MAX_INFLIGHT
                        && Self::supports(m, model)
                    {
                        // 命中且可用才续期：失效 pin 不续命（TTL 语义保真）
                        if let Some(entry) = inner.sessions.get_mut(sid) {
                            entry.1 = Instant::now();
                        }
                        *inner.inflight.entry(m.id.clone()).or_insert(0) += 1;
                        return Some(idx);
                    }
                }
            }
        }
        // 两轮扫描（带模型过滤时）：第一轮只收「专号」——模型面确认且仅含请求模型的号
        //（实测：夜卡号仅 GLM-5.3-Flash，周卡双桶号 5.3+Flash）。Flash 请求优先吃专号，
        // 把全能号留给 GLM-5.3 这种没有替代选择的请求；专号全忙/冷却才落回第二轮原序。
        // 模型面未知（None）按万能号进第二轮，不当专号；无模型过滤只扫一轮，行为同旧。
        let rounds = if model.is_some() { 2 } else { 1 };
        for pass in 0..rounds {
            for i in 0..n {
                let idx = (inner.cursor + i) % n;
                let m = &members[idx];
                if inner.cool.contains_key(&m.id) {
                    continue;
                }
                if inner.inflight.get(&m.id).copied().unwrap_or(0) >= MAX_INFLIGHT {
                    continue;
                }
                if !Self::supports(m, model) {
                    continue;
                }
                if pass == 0 && rounds == 2 && !Self::is_dedicated(m, model) {
                    continue;
                }
                *inner.inflight.entry(m.id.clone()).or_insert(0) += 1;
                inner.cursor = idx;
                // 新选中的号记为该会话的 pin（settle 失败时解除）
                if let Sticky::Session(sid) = sticky {
                    inner.sessions.insert(sid.to_string(), (m.id.clone(), Instant::now()));
                }
                return Some(idx);
            }
        }
        None
    }

    /// 专号判定：模型面确认（Some）且仅含请求模型一个名字——该号除它别无他选，
    /// 请求它不挤占其他模型的容量。模型面未知或含多模型的号都不是专号。
    fn is_dedicated(m: &PoolMember, model: Option<&str>) -> bool {
        match (&m.models, model) {
            (Some(list), Some(req)) => list.len() == 1 && list[0].eq_ignore_ascii_case(req),
            _ => false,
        }
    }

    /// 模型路由判定：Some(集合) 必须包含请求模型（大小写不敏感）；None = 模型面未知按万能号放行。
    /// 实测套餐间模型面不同：周卡含 GLM-5.3 + GLM-5.3-Flash，夜卡仅 GLM-5.3-Flash。
    pub fn supports(m: &PoolMember, model: Option<&str>) -> bool {
        match (&m.models, model) {
            (Some(list), Some(req)) => list.iter().any(|x| x.eq_ignore_ascii_case(req)),
            _ => true,
        }
    }

    /// 池内是否还有号支持该模型（pick 返回 None 时区分「全员冷却」与「模型没人有」）
    pub fn any_supports(members: &[PoolMember], model: Option<&str>) -> bool {
        members.iter().any(|m| Self::supports(m, model))
    }

    /// 请求收尾：在飞 -1；失败时游标挪到下一号并按档落冷却、解除该会话 pin；
    /// 成功时仅粘性关才挪游标（轮换分摊）——粘性的全部实现就是这一处分支
    pub fn settle(&self, member_id: &str, idx: usize, member_count: usize, ok: bool, cooldown_secs: u64, sticky: Sticky<'_>) {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if ok { inner.total_ok += 1 } else { inner.total_err += 1 }
        if let Some(c) = inner.inflight.get_mut(member_id) {
            *c = c.saturating_sub(1);
        }
        // 成功率熔断：满窗且错误率 ≥ 80% → 长冷却并清窗重新观察（覆盖单次短冷却压不住的慢性故障）
        let hist = inner.hist.entry(member_id.to_string()).or_default();
        hist.push_back(ok);
        if hist.len() > TRIP_WINDOW {
            hist.pop_front();
        }
        let tripped = hist.len() == TRIP_WINDOW
            && hist.iter().filter(|&&o| !o).count() * 5 >= TRIP_WINDOW * 4;
        if tripped {
            hist.clear();
            inner.cool.insert(
                member_id.to_string(),
                Instant::now() + Duration::from_secs(TRIP_COOLDOWN_SECS),
            );
        }
        // 连续失败熔断（互补触发器）：失败连击 +1、成功清零；达到阈值即长冷却并清零计数。
        // 比成功率窗更快反应「新坏掉的号」——窗口还没满它就先跳。先取阈值快照再操作计数，避开借用冲突
        let allowed = inner.allowed_fails;
        let streak = inner.fail_streak.entry(member_id.to_string()).or_insert(0);
        if ok {
            *streak = 0;
        } else {
            *streak += 1;
            if allowed > 0 && *streak >= allowed {
                *streak = 0;
                inner.cool.insert(
                    member_id.to_string(),
                    Instant::now() + Duration::from_secs(TRIP_COOLDOWN_SECS),
                );
            }
        }
        if member_count > 0 && (!ok || !inner.sticky) {
            inner.cursor = (idx + 1) % member_count;
        }
        if !ok {
            if let Sticky::Session(sid) = sticky {
                // 失败解钉：下次该会话重新选号（settle 里重新 pin 的活由 pick 负责）
                inner.sessions.remove(sid);
            }
            // 已熔断则不再落单次短冷却（短档会覆盖刚写的熔断长冷却）
            if cooldown_secs > 0 && !tripped {
                inner
                    .cool
                    .insert(member_id.to_string(), Instant::now() + Duration::from_secs(cooldown_secs));
            }
        }
    }

    pub fn global_backoff(&self, secs: u64) {
        if let Ok(mut inner) = self.0.lock() {
            inner.global_until = Some(Instant::now() + Duration::from_secs(secs));
        }
    }

    /// 预期内容量拒绝（3008 user 级并发上限）专用收尾：释放在飞 + 失败挪游标 +
    /// 解除该会话 pin + 落调用方给的单次冷却，但不进成功率窗口/连败计数。
    /// 与 settle(false) 的差异：3008 不代表账号健康恶化（并发档是结构性约束），
    /// 记入熔断窗口会把 chronic 3008 放大成全池 10min 长冷却雪崩。
    pub fn settle_transient(
        &self,
        member_id: &str,
        idx: usize,
        member_count: usize,
        cooldown_secs: u64,
        sticky: Sticky<'_>,
    ) {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        inner.total_err += 1; // 统计口径如实：这是真实发生的上游失败
        if let Some(c) = inner.inflight.get_mut(member_id) {
            *c = c.saturating_sub(1);
        }
        if member_count > 0 {
            inner.cursor = (idx + 1) % member_count;
        }
        if let Sticky::Session(sid) = sticky {
            inner.sessions.remove(sid);
        }
        if cooldown_secs > 0 {
            inner
                .cool
                .insert(member_id.to_string(), Instant::now() + Duration::from_secs(cooldown_secs));
        }
    }

    /// 状态快照：账号 id → 冷却剩余秒；全局退避；累计计数。twoapi_status / 前端池可视化消费。
    pub fn snapshot(&self, members: &[PoolMember]) -> Value {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return Value::Null,
        };
        Self::sweep(&mut inner);
        let now = Instant::now();
        let members_json: Vec<Value> = members
            .iter()
            .map(|m| {
                let cool_left = inner
                    .cool
                    .get(&m.id)
                    .and_then(|t| t.saturating_duration_since(now).as_secs().into())
                    .unwrap_or(0u64);
                json!({
                    "id": m.id, "name": m.name,
                    "inflight": inner.inflight.get(&m.id).copied().unwrap_or(0),
                    "cooldown_secs": cool_left,
                })
            })
            .collect();
        json!({
            "members": members_json,
            "global_backoff_secs": inner.global_until
                .and_then(|t| t.saturating_duration_since(now).as_secs().into())
                .unwrap_or(0u64),
            "total_ok": inner.total_ok,
            "total_err": inner.total_err,
        })
    }

    /// 全局退避剩余秒（0 = 未在退避）。全员不可用但未在退避时返回 1，客户端至少退一秒。
    pub fn global_backoff_secs(&self) -> u64 {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        Self::sweep(&mut inner);
        match inner.global_until {
            Some(t) => t.saturating_duration_since(Instant::now()).as_secs().max(1),
            None => 0,
        }
    }
}

/// 农场成员清单：账号库投影，每次请求现取（claim_token 内部有缓存路径）。
/// 跳过未登录与 jwt_expired 的号；单号 token 解密失败不连坐整池。
pub fn members() -> Result<Vec<PoolMember>, String> {
    let paths = crate::Paths::detect();
    let secret = crate::zcrypto::default_secret(&paths.home);
    let accounts = crate::store::list_accounts(&paths)?;
    let mut out = Vec::new();
    for a in accounts {
        if !crate::store::is_logged_in(&a.credentials) {
            continue;
        }
        if crate::store::account_jwt_expired(&a.credentials, &paths.home) {
            continue;
        }
        // per-account 虚拟 mid：与切号解耦，每个农场号有稳定独立设备身份
        let mid = crate::store::ensure_virtual_device_mid(&paths, &a.id).ok();
        let token = match crate::claim::claim_token(&a.credentials, a.config.as_ref(), &secret) {
            Ok(t) => t,
            Err(_) => continue,
        };
        out.push(PoolMember {
            id: a.id,
            name: a.name,
            token,
            mid,
            // 模型面由 /v1/models 动态聚合（server.rs fetch_model_names）现拉，
            // members() 保持同步快路径——balance 请求是网络 IO，不能在这做
            models: None,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members2() -> Vec<PoolMember> {
        vec![
            PoolMember { id: "a".into(), name: "A".into(), token: "t".into(), mid: None, models: None },
            PoolMember { id: "b".into(), name: "B".into(), token: "t".into(), mid: None, models: None },
        ]
    }

    #[test]
    fn sticky_stays_on_success_rotates_when_off() {
        let m = members2();
        let pool = Pool::new();
        // 粘性：成功后驻留同号
        let i = pool.pick(&m, Sticky::None, None).unwrap();
        pool.settle(&m[i].id, i, m.len(), true, 0, Sticky::None);
        assert_eq!(pool.pick(&m, Sticky::None, None).unwrap(), i);
        // 轮换：成功也让游标前移
        pool.set_sticky(false);
        let i = pool.pick(&m, Sticky::None, None).unwrap();
        pool.settle(&m[i].id, i, m.len(), true, 0, Sticky::None);
        assert_eq!(pool.pick(&m, Sticky::None, None).unwrap(), (i + 1) % m.len());
        // 失败永远换号 + 落冷却
        let i = pool.pick(&m, Sticky::None, None).unwrap();
        pool.settle(&m[i].id, i, m.len(), false, 60, Sticky::None);
        let j = pool.pick(&m, Sticky::None, None).unwrap();
        assert_ne!(j, i);
        assert!(pool.snapshot(&m)["members"][i]["cooldown_secs"].as_u64().unwrap() > 0);
    }

    #[test]
    fn capacity_rejections_never_trip_breaker() {
        let m = members2();
        let pool = Pool::new();
        // 连败阈值压到 2（settle(false) 两次即长冷却）作为放大器对照
        pool.set_allowed_fails(2);
        // 3008 走 transient：连撞 6 次不触发熔断，池保持可用，无任何冷却
        for _ in 0..6 {
            let i = pool.pick(&m, Sticky::None, None).unwrap();
            pool.settle_transient(&m[i].id, i, m.len(), 0, Sticky::None);
        }
        for idx in 0..m.len() {
            let cd = pool.snapshot(&m)["members"][idx]["cooldown_secs"].as_u64().unwrap();
            assert_eq!(cd, 0, "member {idx} 不得进任何冷却（含熔断）");
        }
        assert!(pool.pick(&m, Sticky::None, None).is_some());
    }

    #[test]
    fn session_affinity_pins_and_releases() {
        let m = members2();
        let pool = Pool::new();
        // 轮换模式（全局粘性关）：无 session 的 pick 逐号分摊……
        pool.set_sticky(false);
        let a = pool.pick(&m, Sticky::None, None).unwrap();
        pool.settle(&m[a].id, a, m.len(), true, 0, Sticky::None);
        // ……但带 session 的请求仍钉在同一号（会话亲和独立于全局游标）
        let s = pool.pick(&m, Sticky::Session("S1"), None).unwrap();
        pool.settle(&m[s].id, s, m.len(), true, 0, Sticky::Session("S1"));
        assert_eq!(pool.pick(&m, Sticky::Session("S1"), None).unwrap(), s);
        // 失败解钉 + 号落冷却：同 session 下次换到别的号
        pool.settle(&m[s].id, s, m.len(), false, 60, Sticky::Session("S1"));
        let j = pool.pick(&m, Sticky::Session("S1"), None).unwrap();
        assert_ne!(j, s);
        // 粘性模式（开关开）：session pin 与全局游标都驻留
        pool.set_sticky(true);
        let k = pool.pick(&m, Sticky::Session("S2"), None).unwrap();
        pool.settle(&m[k].id, k, m.len(), true, 0, Sticky::Session("S2"));
        assert_eq!(pool.pick(&m, Sticky::Session("S2"), None).unwrap(), k);
    }

    #[test]
    fn success_rate_breaker_trips_on_chronic_errors() {
        let m = members2();
        let pool = Pool::new();
        // a 先失败一次（游标挪到 b），b 再失败落长冷却退出池，此后 pick 恒选 a
        let i0 = pool.pick(&m, Sticky::None, None).unwrap();
        pool.settle(&m[i0].id, i0, m.len(), false, 0, Sticky::None);
        let ib = pool.pick(&m, Sticky::None, None).unwrap();
        assert_eq!(ib, 1);
        pool.settle(&m[ib].id, ib, m.len(), false, 3600, Sticky::None);
        // 慢性失败：单次冷却 0 压不住，连续失败攒窗口；9/10 未满窗不触发（a 窗口已含开头那次）
        for _ in 0..8 {
            let i = pool.pick(&m, Sticky::None, None).unwrap();
            assert_eq!(i, 0);
            pool.settle(&m[i].id, i, m.len(), false, 0, Sticky::None);
            assert_eq!(pool.snapshot(&m)["members"][0]["cooldown_secs"].as_u64().unwrap(), 0);
        }
        // 第 10 次失败满窗（100% 错误率）→ 熔断长冷却，pick 无号可用
        let i = pool.pick(&m, Sticky::None, None).unwrap();
        pool.settle(&m[i].id, i, m.len(), false, 0, Sticky::None);
        assert!(pool.snapshot(&m)["members"][0]["cooldown_secs"].as_u64().unwrap() >= 599);
        assert!(pool.pick(&m, Sticky::None, None).is_none());
    }

    #[test]
    fn dedicated_members_serve_single_model_first() {
        // 0 号全能（5.3+flash，周卡双桶）、1 号专号（仅 flash，夜卡）。
        // Flash 请求优先吃专号，全能号留给 GLM-5.3（它没有替代选择）
        let mut m = members2();
        m[0].models = Some(vec!["glm-5.3".into(), "glm-5.3-flash".into()]);
        m[1].models = Some(vec!["glm-5.3-flash".into()]);
        let pool = Pool::new();
        assert_eq!(pool.pick(&m, Sticky::None, Some("glm-5.3-flash")).unwrap(), 1);
        pool.settle(&m[1].id, 1, m.len(), false, 3600, Sticky::None);
        assert_eq!(pool.pick(&m, Sticky::None, Some("glm-5.3-flash")).unwrap(), 0, "专号冷却才落全能号");
        pool.settle(&m[0].id, 0, m.len(), true, 0, Sticky::None);
        assert_eq!(pool.pick(&m, Sticky::None, Some("glm-5.3")).unwrap(), 0, "5.3 只能走全能号");
        // 全能号也故障冷却后：两个模型都无号可用
        pool.settle(&m[0].id, 0, m.len(), false, 3600, Sticky::None);
        assert!(pool.pick(&m, Sticky::None, Some("glm-5.3-flash")).is_none());
        assert!(pool.pick(&m, Sticky::None, Some("glm-5.3")).is_none(), "全能号冷却 5.3 无家可归");
        // 无模型过滤不分轮：专号逻辑不干预旧轮转
        let m2 = members2();
        let pool2 = Pool::new();
        let i = pool2.pick(&m2, Sticky::None, None).unwrap();
        pool2.settle(&m2[i].id, i, m2.len(), true, 0, Sticky::None);
        assert_eq!(pool2.pick(&m2, Sticky::None, None).unwrap(), i, "粘性驻留不受分轮影响");
    }

    #[test]
    fn model_routing_filters_unsupported_members() {
        // 周卡：5.3 + flash；夜卡：仅 flash（实测模型面）。请求 5.3 只能命中周卡号
        let mut m = members2();
        m[0].models = Some(vec!["glm-5.3".into(), "glm-5.3-flash".into()]);
        m[1].models = Some(vec!["glm-5.3-flash".into()]);
        let pool = Pool::new();
        assert!(Pool::supports(&m[0], Some("GLM-5.3")));
        assert!(!Pool::supports(&m[1], Some("GLM-5.3")));
        // 模型面未知（None）按万能号放行
        assert!(Pool::supports(&PoolMember { id: "x".into(), name: "X".into(), token: "t".into(), mid: None, models: None }, Some("GLM-5.3")));
        for _ in 0..3 {
            let i = pool.pick(&m, Sticky::None, Some("glm-5.3")).unwrap();
            assert_eq!(i, 0, "5.3 只在 0 号");
            pool.settle(&m[i].id, i, m.len(), true, 0, Sticky::None);
        }
        assert!(pool.pick(&m, Sticky::None, Some("glm-5.3-flash")).is_some());
        assert!(Pool::any_supports(&m, Some("glm-5.3")));
    }
}
