// store.js — 状态与动作层（自 main.js 原样抽出）
// React 渲染层经 useSyncExternalStore 订阅版本号；emit() 取代原 render()
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast, openPwModal, openConfirmModal, openProviderModal, openBrowserLoginModal, closeBrowserLoginModal } from "../components/ui-bus.js";
import { init, t, lang, localeTag, stripErr, syncLang, patchLang } from "./i18n.js";
import { silentUpdateCheck } from "./updater.js";

// ---- 订阅机制 ----
let version = 0;
const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function getVersion() { return version; }
export function emit() { version++; subs.forEach((fn) => fn()); }

// ---- 状态（原模块级变量收编为一个对象） ----
export const store = {
  state: null,          // get_state 结果
  renaming: null,       // 重命名中的账号 id
  renamingText: "",     // 重命名输入框内容（受控）
  bootError: null,      // 启动失败信息
  appVer: "",
  switching: false,     // 账号切换进行中（强杀+冷启动最长 10s，UI 需可见反馈）
  switchingId: null,    // 正在切入的账号 id（行内旋转图标定位用）
  busyGuard: false,     // guard 互斥锁的可见镜像（切换等重操作跑着时界面可读）
  acctQuota: {},        // id -> {data?, err?, busy}
  claimable: {},        // id -> {plans?, err?, busy}
  claimHistory: {},     // id -> {history?, err?}（claim-history.json，userId 键）
  referral: {},         // id -> {summary?, invitees?, err?, busy}
};

let busy = false;
let claimAllRunning = false;
const REFRESH_CLAIM_COOLDOWN_MS = 60_000;
let refreshClaim = { running: false, done: 0, total: 0, cooldownUntil: 0 };
let refreshTicker = null;

// ---- touch 429 退避表（per-account） ----
// touch 429 上抛后手动路径此前无退避：catch 不写 refreshedAt，用户立刻再点立刻再撞。
// 失败也进冷却，且 429 连续命中指数升级：60s → 2min → 4min → 8min → 封顶 15min；
// 成功或非 429 失败回退基准 60s。窗口衰减不做（内存表随重启重置，足够用）。
const touch429Count = {};
function touchCooldownFor(id, errMsg) {
  const hit = String(errMsg || "").includes("429");
  if (hit) touch429Count[id] = (touch429Count[id] || 0) + 1;
  else touch429Count[id] = 0;
  const base = REFRESH_CLAIM_COOLDOWN_MS;
  const mult = Math.min(2 ** (touch429Count[id] - 1), 15 * 60 / 60); // 封顶 15min
  return base * Math.max(mult, 1);
}

const AUTO_CLAIM_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_CLAIM_FIRST_DELAY_MS = 2 * 60 * 1000;
// 启动后延迟做更新检查：等窗口起来、splash 散去再弹提示，不跟开机首屏抢注意力
const BOOT_UPDATE_CHECK_MS = 15_000;
const AUTO_CLAIM_WAIT_MS = 45_000;
const AUTO_CLAIM_PER_ACCOUNT_CAP = 5;
// 号与号之间 5s：领取通道 3012/405 按出口 IP 计数（SecurityReject 1h 起步），
// 串行间隔太短等于同一 IP 连续打风控敏感端点
const AUTO_CLAIM_ACCT_GAP_MS = 5_000;
const AUTO_ABORT_WAIT_MS = 10 * 60 * 1000;
let autoClaimRunning = false;
// 错相拆分后的第二条循环：touch 查询在跑的标志（与 autoClaimRunning 互斥）
let autoTouchRunning = false;
// touch 循环最近一轮摘要（at/ok/fail），tooltip 与 lastAutoRound 并列展示
let lastTouchRound = null;
const autoClaimCooldown = {};
let autoAbortRequested = false;
let claimActive = false;
let lastAutoRound = null;
let autoToggleBusy = false;
// 单号探测在跑的标志：它只占 claimable[id].busy，批量探测/自动领取开关看不到它
let refreshOneBusy = false;

const SWEEP_PERIOD = 5 * 60 * 1000;
const SWEEP_JITTER = 0.2;
const TICK_MS = 8000;
// 一跳最多并发几个到期账号；后端 get_account_quota 已走 spawn_blocking，不占 runtime 线程
const SWEEP_BATCH = 4;
const quotaDue = {};
let ticking = false;

// ---- 纯工具 ----
const NOTCH_COLORS = ["var(--notch-1)", "var(--notch-2)", "var(--notch-3)", "var(--notch-4)", "var(--notch-5)", "var(--notch-6)"];
export function notchColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return NOTCH_COLORS[h % NOTCH_COLORS.length];
}

export function fmtNum(v) {
  if (v == null) return t("q.unknown");
  const n = Number(v);
  if (!isFinite(n)) return t("q.unknown");
  if (lang() === "zh") {
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + " 万";
    return n.toLocaleString(localeTag(), { maximumFractionDigits: 2 });
  }
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return n.toLocaleString(localeTag(), { maximumFractionDigits: 2 });
}
export function idLabel(id) {
  if (!id) return null;
  return id.display_name || id.username || id.email || null;
}

export function uiLocked() {
  return store.renaming !== null;
}

// ---- 数据加载 ----
async function refresh() {
  store.state = patchLang(await invoke("get_state"));
  if (store.state?.language) syncLang(store.state.language);
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  store.busyGuard = true;
  emit();
  try {
    await fn();
  } catch (e) {
    toast(stripErr(e), "err");
  } finally {
    busy = false;
    store.busyGuard = false;
    emit();
  }
}

export async function loadAcctQuota(id) {
  const cur = store.acctQuota[id] || {};
  if (cur.busy) return;
  store.acctQuota[id] = { busy: true };
  emit();
  try {
    const data = await invoke("get_account_quota", { id });
    store.acctQuota[id] = { data, err: null, busy: false };
  } catch (e) {
    store.acctQuota[id] = { data: null, err: stripErr(e), busy: false };
  }
  emit();
}

// ---- 领取历史（claim-history.json，按 userId 分组） ----
// 键在后端用 userId（JWT sub）：重登换 accountId 也能命中同一个人的记录。
// id -> { history: [{planId, planName, claimed_at, effective_at, ends_at}] | null, err? }

async function loadClaimHistory(id) {
  try {
    const history = await invoke("claim_history", { id });
    store.claimHistory[id] = { history: history || [], err: null };
  } catch (e) {
    store.claimHistory[id] = { history: null, err: stripErr(e) };
  }
  emit();
}

async function loadClaimPreview(id) {
  const cur = store.claimable[id] || {};
  if (cur.busy) return;
  store.claimable[id] = { plans: cur.plans || [], busy: true };
  try {
    const plans = await invoke("claim_refresh_one", { id });
    store.claimable[id] = { plans: plans || [], err: null, busy: false };
    // touch 空 ≠ 无事发生：补一次待生效判定（balance 里 active 且桶未下发的套餐）。
    // 仅在 touch 空时打这第二次请求，省一次上游往返；失败静默为无待生效态。
    // per-account 10 分钟节流：没投放的号每轮都打 balance 就是双倍上游请求，
    // 正是 429/3012 要防的场景；领取成功（pending 解冻）或手动单号刷新不受限
    if (!plans?.length) {
      store.claimable[id].pending = await pendingCheckThrottled(id);
      // touch 空时顺手拉领取历史（本地文件读取，零上游流量），账号行「已领取过」展示用
      loadClaimHistory(id);
    } else {
      store.claimable[id].pending = null;
    }
  } catch (e) {
    const msg = stripErr(e);
    // touch 429 上抛：失败也进冷却（此前 catch 不写 refreshedAt，用户立刻再点立刻再撞），
    // 429 连续命中指数升级（60s→2min→…→15min 封顶），非 429 失败回退基准
    store.claimable[id] = { plans: cur.plans || [], err: msg, busy: false, refreshedAt: Date.now() + touchCooldownFor(id, msg) - REFRESH_CLAIM_COOLDOWN_MS };
  }
}

// ---- 待生效判定节流 ----
// touch 空时的 balance 反推是纯推断态，10 分钟内复用上次结果即可；领取成功后
// 服务端状态变了，立即解冻让下次刷新拿到真实判定
const PENDING_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const pendingCheckAt = {};
async function pendingCheckThrottled(id, force = false) {
  if (!force && Date.now() - (pendingCheckAt[id] || 0) < PENDING_CHECK_COOLDOWN_MS) {
    return store.claimable[id]?.pending ?? null; // 冷却期内复用上次判定
  }
  pendingCheckAt[id] = Date.now();
  return await invoke("claim_pending_check", { id }).catch(() => null);
}

// ---- referral 邀请 ----
let referralWaiter = null;
let referralBindRunning = false;

// 验证码窗口是 claim/bind 共用的单一资源：后端在任一侧发起时清掉对方 pending，
// 前端一侧进行时另一侧直接拒绝，避免被清方的 waiter 干等 90s 超时
const claimSideBusy = () => !!(claimWaiter || claimActive || claimAllRunning || refreshClaim.running || autoClaimRunning || autoTouchRunning);
const referralSideBusy = () => !!(referralWaiter || referralBindRunning);

export async function loadReferral(id) {
  const cur = store.referral[id] || {};
  if (cur.busy) return;
  store.referral[id] = { ...cur, busy: true, err: null };
  emit();
  try {
    const [summary, invitees] = await Promise.all([
      invoke("referral_summary", { id }),
      invoke("referral_invitees", { id }).catch(() => null),
    ]);
    store.referral[id] = { summary: summary?.data || summary, invitees: invitees?.data || null, err: null, busy: false };
  } catch (e) {
    store.referral[id] = { ...cur, busy: false, err: stripErr(e) };
  }
  emit();
}

// 邀请页全量加载：与 sweep 同款小并发分批，错峰打满不挤爆
export async function loadAllReferrals(ids) {
  const BATCH = 4;
  const GAP_MS = 800;
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(ids.slice(i, i + BATCH).map((id) => loadReferral(id)));
    if (i + BATCH < ids.length) await new Promise((res) => setTimeout(res, GAP_MS));
  }
}

function waitForReferralResult(accountId, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; referralWaiter = null; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), timeoutMs);
    referralWaiter = { accountId, finish };
  });
}

let claimWaiter = null;
function waitForClaimResult(accountId, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; claimWaiter = null; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), timeoutMs);
    claimWaiter = { accountId, finish };
  });
}

async function awaitClaimableFresh(id) {
  store.claimable[id] = { ...(store.claimable[id] || {}), busy: true };
  try {
    const plans = await invoke("claim_refresh_one", { id });
    store.claimable[id] = { plans: plans || [], err: null, busy: false, pending: plans?.length ? null : (await pendingCheckThrottled(id)) || null };
    // touch 空时顺手拉领取历史（本地文件读取，零上游流量）
    if (!plans?.length) loadClaimHistory(id);
  } catch (e) {
    const msg = stripErr(e);
    // touch 429 上抛：失败也进冷却（refreshedAt 语义对齐其余路径），429 连续命中指数升级
    store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: msg, busy: false, refreshedAt: Date.now() + touchCooldownFor(id, msg) - REFRESH_CLAIM_COOLDOWN_MS };
  }
}

export const accountName = (id) => (store.state?.accounts || []).find((a) => a.id === id)?.name || id;

export function autoPillTitle(s) {
  const bits = [t("btn.autoClaimTitle")];
  if (autoTouchRunning || autoClaimRunning) bits.push(t((s.auto_claim || s.auto_touch) ? "m.autoClaimRound" : "m.autoClaimStopping"));
  if (lastTouchRound) {
    const d = new Date(lastTouchRound.at);
    const time = d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString(localeTag(), { hour12: false })
      : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toLocaleTimeString(localeTag(), { hour12: false })}`;
    bits.push(t("m.autoTouchLast", { time, ok: lastTouchRound.ok, fail: lastTouchRound.fail }));
  }
  if (lastAutoRound) {
    const d = new Date(lastAutoRound.at);
    const time = d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString(localeTag(), { hour12: false })
      : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toLocaleTimeString(localeTag(), { hour12: false })}`;
    bits.push(t("m.autoClaimLast", { time, claimed: lastAutoRound.claimed, skipped: lastAutoRound.skipped }));
    if (lastAutoRound.cooldownAll) bits.push(t("m.autoClaimCooldownAll"));
  }
  return bits.join(" · ");
}

// ---- 定时调度（sweep） ----
function scheduleNext(id, base = Date.now()) {
  const jitter = 1 + (Math.random() * 2 - 1) * SWEEP_JITTER;
  quotaDue[id] = base + Math.round(SWEEP_PERIOD * jitter);
}
function enrollAccounts() {
  const live = new Set((store.state?.accounts || []).map((a) => a.id));
  for (const id of live) if (!(id in quotaDue)) quotaDue[id] = Date.now();
  for (const id of Object.keys(quotaDue)) if (!live.has(id)) delete quotaDue[id];
}
function pokeAccount(id) { if (id) quotaDue[id] = Date.now(); }

async function sweepTick() {
  if (ticking) return;
  enrollAccounts();
  const now = Date.now();
  const due = (store.state?.accounts || [])
    .filter(
      (a) => (quotaDue[a.id] ?? Infinity) <= now && !store.acctQuota[a.id]?.busy && !store.claimable[a.id]?.busy,
    )
    .slice(0, SWEEP_BATCH);
  if (!due.length) return;
  ticking = true;
  try {
    await Promise.all(
      due.map(async (a) => {
        const dueAt = quotaDue[a.id];
        await loadAcctQuota(a.id);
        if (quotaDue[a.id] === dueAt) scheduleNext(a.id);
      }),
    );
  } finally {
    ticking = false;
  }
}

// ---- auto claim ----
// 批量跳过判定：登录令牌已过期 / 快照缺资格登录信息的号刷了必失败，批量操作前剔除
const skipReason = (a) => (a?.jwt_expired ? t("btn.jwtExpired") : a?.has_user_info === false ? t("btn.relogin") : null);

// 有界并发批量探测投放：claim_refresh_one 每号独立、跑 blocking 线程池无共享锁。
// 并发硬上限 2：一次最多同时探测两个账号，批间隔 60s——
// 15 号分 8 批约 7 分钟、20 号约 9 分钟，号间充分拉开避免 429。
// 调度器 await 本轮完成后才排下一轮，探测超时也不会与前一轮重叠。调用方传 chunkGapMs
async function refreshClaimBatch(ids, chunkGapMs, onOne) {
  const CONCURRENCY = 2;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => onOne(id)));
    if (i + CONCURRENCY < ids.length) await new Promise((res) => setTimeout(res, chunkGapMs));
  }
}

// ---- 3012 退避表（per-account，SecurityReject 族独立于 429） ----
// 3012/405（出口 IP/指纹级风控）连续命中冷却倍增：1h → 2h → 4h → 8h → 封顶 7 天；
// 与 429 的 60s 基准表分开管——两者惩罚维度不同（IP 级 vs 请求级）。
// 窗口衰减不做持久化：内存表随重启重置，等价于 7 天窗口的最简形态。
const secReject3012Count = {};
const SEC_REJECT_BASE_MS = 60 * 60 * 1000;        // 1h
const SEC_REJECT_CAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// 领取失败退避分流：按结构化字段（httpStatus/bizCode）三轨判定——
// HTTP 429（传输层限流）→ 60s 指数升级（复用 touch429Count 表）；
// 业务限流（30xx，RateLimited 族）→ 60 分钟固定；
// 3012/405（SecurityReject，body code=3012 或 HTTP 405 形态）→ 1h 指数倍增封顶 7 天；
// 其余业务失败（1005 额度用完等）→ nextAt 权威或 60 分钟。
function autoClaimCooldownFor(r) {
  const now = Date.now();
  // 权威冷却优先：任意失败码带 nextAt（data.plan.ends_at，桌面对齐）都用它
  if (r.nextAt) return r.nextAt;
  const http = Number.isFinite(r.httpStatus) ? r.httpStatus : 0;
  const biz = Number.isFinite(r.bizCode) ? r.bizCode : -1;
  // HTTP 层 429：touch429Count 表的指数升级（60s→…→15min）
  if (http === 429) return now + touchCooldownFor(r.accountId, "429");
  // 业务码 3012 或 HTTP 405 形态（UPSTREAM-3012.md 实锤的拒绝形态）：SecurityReject 倍增
  if (biz === 3012 || (http === 405 && biz >= 1000)) {
    secReject3012Count[r.accountId] = (secReject3012Count[r.accountId] || 0) + 1;
    const mult = Math.min(2 ** (secReject3012Count[r.accountId] - 1), SEC_REJECT_CAP_MS / SEC_REJECT_BASE_MS);
    return now + SEC_REJECT_BASE_MS * Math.max(mult, 1);
  }
  // 业务限流族（3002/3008/3009/3010）：60 分钟固定（请求级惩罚，指数升级无证据支持）
  if (biz >= 3000 && biz < 3100 && biz !== 3012) return now + 60 * 60 * 1000;
  // 其余业务失败（1005 额度用完 / interactive）：60 分钟
  if (Number.isFinite(r.code) && r.code >= 1000) return now + 60 * 60 * 1000;
  if (r.code === "interactive") return now + 60 * 60 * 1000;
  return now + AUTO_CLAIM_INTERVAL_MS;
}

// 单号自动领取核心：claim_start（内部自带 touch 重取投放）→ 等结果 → 冷却/重试。
// 从 autoClaimTick 拆出：探测循环的跟领与兜底扫描共用一条路径，语义不分叉
async function claimOneAutoCore(id) {
  let gotAny = false;
  let attempts = 0;
  let progressed = true;
  while (progressed && attempts < AUTO_CLAIM_PER_ACCOUNT_CAP) {
    if (autoAbortRequested) break;
    attempts++;
    progressed = false;
    const plan = store.claimable[id]?.plans?.[0];
    if (!plan) break;
    if (referralSideBusy()) { // bind 占用验证码窗口：本轮跳过，冷却后重试
      autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
      break;
    }
    try {
      await invoke("claim_start", { id, planId: plan.plan_id, auto: true });
    } catch (e) {
      await invoke("claim_cancel").catch(() => {});
      autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
      break;
    }
    const r = await waitForClaimResult(id, AUTO_CLAIM_WAIT_MS);
    if (!r) {
      await invoke("claim_cancel").catch(() => {});
      autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
      break;
    }
    if (r.ok === false) {
      autoClaimCooldown[id] = autoClaimCooldownFor(r);
      break;
    }
    gotAny = true;
    await awaitClaimableFresh(id);
    emit();
    progressed = true;
    await new Promise((res) => setTimeout(res, 1200));
  }
  return gotAny;
}

// 探测跟领串行链：探测批并发 2，两个号同时 touch 到投放时领取必须排队——
// 验证码会话单例（claimWaiter 单槽）+ 出口 IP 级风控，领取全局串行。
// 跟领是投放 TTL 的唯一解：11-17 实测投放签发后约 30s 过期（探测 25s 后才
// 轮到的号 claim_start 内部 touch 全部 claim.gone），只有「touch 到资格立刻
// 领」能赶在过期前提交；先探测完再领取的两段式后半段注定过期
let autoClaimChain = Promise.resolve();
function enqueueAutoClaim(id) {
  const run = autoClaimChain.then(async () => {
    if (!store.state?.auto_claim || autoAbortRequested) return false;
    if (autoClaimRunning || claimAllRunning) return false;
    if (!(store.claimable[id]?.plans || []).length) return false;
    if ((autoClaimCooldown[id] ?? 0) > Date.now()) return false;
    autoClaimRunning = true; claimActive = true;
    emit();
    try {
      return await claimOneAutoCore(id);
    } finally {
      autoClaimRunning = false; claimActive = false;
      emit();
    }
  });
  autoClaimChain = run.catch(() => {});
  return run;
}

// 手动入口等待自动领取收尾：跟领链 + 兜底扫描共用 autoClaimRunning/claimActive，
// 一轮领取含验证码提交最长 AUTO_CLAIM_WAIT_MS/号，等待上限按一轮 14 号 + 余量给
async function waitClaimIdle(maxMs = 5 * 60 * 1000) {
  const deadline = Date.now() + maxMs;
  while ((autoClaimRunning || claimActive) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 300));
  }
  return !(autoClaimRunning || claimActive);
}

// 自动 touch：批量查投放填 claimable 缓存。与领取循环错相运行（相位差半周期），
// 任何时刻只有一条循环在上游打请求——touch 429 按请求级计数、claim 3012 按出口 IP
// 级计数，两通道挤同一时间窗是双重风控放大器
async function autoTouchTick() {
  if (!store.state?.auto_touch || autoTouchRunning) return;
  if (autoClaimRunning || claimActive || claimAllRunning || refreshClaim.running || refreshOneBusy) return;
  const ids = (store.state.accounts || [])
    .filter((a) => !skipReason(a))
    .map((a) => a.id)
    .filter((id) => (autoClaimCooldown[id] ?? 0) <= Date.now());
  if (!ids.length) return;
  autoTouchRunning = true; autoAbortRequested = false;
  let roundOk = 0, roundFail = 0;
  emit();
  try {
    // 批间 60s：15 号分 8 批约 7 分钟打完一轮，号间充分拉开是 429 主要缓解手段
    const accIds = () => store.state.accounts || [];
    await refreshClaimBatch(ids, 60_000, async (id) => {
      if (!store.state?.auto_touch || autoAbortRequested) return;
      if (!accIds().some((a) => a.id === id)) return;
      store.claimable[id] = { ...(store.claimable[id] || {}), busy: true };
      try {
        const plans = (await invoke("claim_refresh_one", { id })) || [];
        store.claimable[id] = { plans, err: null, busy: false, pending: plans.length ? null : (await pendingCheckThrottled(id)) || null };
        // touch 空时顺手拉领取历史（本地文件读取，零上游流量）
        if (!plans.length) loadClaimHistory(id);
        // 融合跟领：自动领取开着时，touch 到投放立刻排队提交（enqueue 内部校验
        // auto_claim/互斥/冷却），不await——批节奏不受影响，领取走串行链
        if (plans.length) enqueueAutoClaim(id);
        roundOk++;
      } catch (e) {
        store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: String(e), busy: false };
        // touch 失败的号同步进领取冷却：查询失败的号本轮无从领取
        autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
        roundFail++;
      }
    });
  } finally {
    autoTouchRunning = false;
    if (store.state?.auto_touch) lastTouchRound = { at: Date.now(), ok: roundOk, fail: roundFail };
    emit();
    // 探测完 3s 立即触发领取：一轮探测要 7-9min，固定错相的 claim 跳
    // 那时探测还没结束会被 gate 跳过，靠这个联动才不会拖到下一相位
    maybeAutoClaimAfterTouch();
  }
}

// 自动领取：消费 claimable 缓存（由 touch 循环或手动刷新填充）。缓存空 = 零上游
// 流量直接空转；领取不做独立周期——touch 查到有投放才有东西可领
async function autoClaimTick() {
  if (!store.state?.auto_claim || autoClaimRunning) return;
  if (autoTouchRunning || claimActive || claimAllRunning || refreshClaim.running || refreshOneBusy) return;
  const ids = (store.state.accounts || [])
    .filter((a) => !skipReason(a))
    .map((a) => a.id)
    .filter((id) => (store.claimable[id]?.plans || []).length > 0)
    .filter((id) => (autoClaimCooldown[id] ?? 0) <= Date.now());
  if (!ids.length) {
    if ((store.state.accounts || []).some((a) => (store.claimable[a.id]?.plans || []).length > 0)) {
      lastAutoRound = { at: Date.now(), claimed: 0, skipped: 0, cooldownAll: true };
    }
    return;
  }
  autoClaimRunning = true; claimActive = true; autoAbortRequested = false;
  let roundClaimed = 0, roundSkipped = 0;
  emit();
  try {
    // 领取保持串行——验证码会话单例（claimWaiter 单槽），且 429/风控按出口 IP 计数，并发领取得不偿失
    for (const id of ids) {
      if (!store.state?.auto_claim || autoAbortRequested) break;
      if (!(store.state.accounts || []).some((a) => a.id === id)) continue;
      if (autoClaimCooldown[id] > Date.now()) continue;
      const got = await claimOneAutoCore(id);
      if (got) roundClaimed++;
      else if ((store.claimable[id]?.plans || []).length) roundSkipped++;
      await new Promise((res) => setTimeout(res, AUTO_CLAIM_ACCT_GAP_MS));
    }
  } finally {
    autoClaimRunning = false; claimActive = false;
    if (store.state?.auto_claim) lastAutoRound = { at: Date.now(), claimed: roundClaimed, skipped: roundSkipped };
    emit();
  }
}

// 错相调度：两条循环名义周期 10min，claim 相位错开半周期。
// touch 一轮要 7-9min（60s × 7-8 批），探测期间 claim 的相位跳会被 gate 跳过；
// 探测结束后由 maybeAutoClaimAfterTouch 3s 内触发领取兜底，不会拖到下一相位。
// 调度器 await 本轮完成后才排下一轮，探测再慢也不会与前一轮重叠。
let autoTouchTimer = null, autoClaimTimer = null;
function scheduleTouch(delayMs) {
  clearTimeout(autoTouchTimer);
  autoTouchTimer = setTimeout(async () => {
    // try/finally 确保 tick 本身或 finally 里的 emit 抛异常时，调度链仍继续
    try { await autoTouchTick(); } catch { /* 单轮异常不能终止整条定时链 */ }
    scheduleTouch(AUTO_CLAIM_INTERVAL_MS);
  }, delayMs);
}
function scheduleClaim(delayMs) {
  clearTimeout(autoClaimTimer);
  autoClaimTimer = setTimeout(async () => {
    try { await autoClaimTick(); } catch { /* 同上 */ }
    scheduleClaim(AUTO_CLAIM_INTERVAL_MS);
  }, delayMs);
}

function startRefreshTicker() {
  if (refreshTicker) return;
  refreshTicker = setInterval(() => { emit(); stopRefreshTickerIfIdle(); }, 1000);
}
function stopRefreshTickerIfIdle() {
  const cooling = Date.now() < refreshClaim.cooldownUntil;
  if (!refreshClaim.running && !cooling && refreshTicker) {
    clearInterval(refreshTicker); refreshTicker = null; emit();
  }
}

// 手动入口等待自动 touch 收尾：一轮探测 60s × 7-8 批约 7-9min，等待上限按
// 一轮最长时间 + 余量给 12min。等待期间按钮 disabled，用户能看到探测进度；
// 超时（异常卡死）才提示稍后再试
async function waitTouchIdle(maxMs = 12 * 60 * 1000) {
  const deadline = Date.now() + maxMs;
  while (autoTouchRunning && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 300));
  }
  return !autoTouchRunning;
}

// 手动 touch（批量/单号）查到投放且自动领取开着：3s 缓冲后立即消费缓存，
// 不等下一相位（最多 10min）。3s 让 touch 连接收尾；错相 gate 保证与在跑
// 循环互斥，claim 失败自带冷却退避
function maybeAutoClaimAfterTouch() {
  if (!store.state?.auto_claim) return;
  const hasPlans = (store.state.accounts || []).some((a) => (store.claimable[a.id]?.plans || []).length > 0);
  if (!hasPlans) return;
  setTimeout(() => { autoClaimTick(); }, 3000);
}

// ---- 动作（原 actions 对象，render() 全部换成 emit()） ----
export const actions = {
  async refresh() { await refresh(); emit(); },

  async capture() {
    await guard(async () => {
      const r = await invoke("capture_current", { name: null });
      toast(t("m.toastSaved", { name: r.name }), "ok", t("m.toastSavedDetail"));
      await refresh(); emit();
      enrollAccounts();
    });
  },

  rename(id) {
    store.renaming = id;
    store.renamingText = (store.state?.accounts || []).find((a) => a.id === id)?.name || "";
    emit();
  },

  setRenamingText(v) { store.renamingText = v; },

  async doRename(id) {
    const name = (store.renamingText || "").trim();
    if (!name) return;
    window.__renameSaving = true;
    clearTimeout(window.__renameBlurTimer);
    await guard(async () => {
      const r = await invoke("rename_account", { id, name });
      toast(t("m.toastRenamed", { name: r.name }));
      store.renaming = null;
      await refresh(); emit();
    }).finally(() => { window.__renameSaving = false; });
  },

  cancelRename() { store.renaming = null; emit(); },

  deferCancelRename(id) {
    clearTimeout(window.__renameBlurTimer);
    window.__renameBlurTimer = setTimeout(() => {
      if (store.renaming === id && !window.__renameSaving) actions.cancelRename();
    }, 180);
  },

  delete(id) {
    const a = store.state?.accounts.find((x) => x.id === id);
    if (!a) return;
    openConfirmModal({
      kind: "danger",
      icon: "x",
      title: t("m.deleteTitle", { name: a.name }),
      desc: t("m.deleteDesc"),
      yesLabel: t("common.delete"),
      onYes: () => actions.doDelete(id),
    });
  },

  async doDelete(id) {
    await guard(async () => {
      await invoke("delete_account", { id });
      toast(t("m.toastDeleted"));
      await refresh(); emit();
    });
  },

  askSwitch(id) {
    const s = store.state;
    if (s.zcode_running && !s.hot_switch) {
      const a = s.accounts.find((x) => x.id === id);
      if (!a) return;
      openConfirmModal({
        kind: "warn",
        icon: "swap",
        title: t("m.switchTitle", { name: a.name }),
        desc: `<span class="warn-line">${t("m.switchDesc", { restart: t(s.launch_after_switch ? "m.switchRestartYes" : "m.switchRestartNo") })}</span>`,
        yesLabel: t("m.switchYes"),
        onYes: () => actions.doSwitch(id, true),
      });
    } else {
      actions.doSwitch(id, false);
    }
  },

  async doSwitch(id, force) {
    if (store.switching) return;
    // 先亮「切换中」再进 guard：强杀+冷启动最长 10s，guard 的互斥是静默的，
    // 用户点完按钮看不到任何动静，会重复点或者以为死了
    store.switching = true;
    store.switchingId = id;
    emit();
    try {
      await guard(async () => {
        const restart = store.state.launch_after_switch;
        const r = await invoke("switch_to", { id, force, restart });
        if (r.already_active) {
          toast(t("m.toastAlready", { name: r.name }), "ok");
        } else {
          const bits = [];
          if (r.hot) bits.push(t("m.bitHot"));
          if (r.killed) bits.push(t("m.bitKilled"));
          if (r.preserved_as) bits.push(t("m.bitPreserved", { name: r.preserved_as }));
          if (r.launched) bits.push(t("m.bitLaunched"));
          if (r.config_stale) bits.push(t("m.bitConfigStale"));
          const verifyBad = r.verify && r.verify.kind !== "entitled";
          if (verifyBad) {
            bits.push(t(r.verify.kind === "no_entitlement" ? "m.bitVerifyNoPlan" : "m.bitVerifyAuthFailed"));
          }
          toast(t("m.toastSwitched", { name: r.name }), (r.config_stale || verifyBad) ? "warn" : "ok", bits.join(t("common.listSep")));
        }
        await refresh(); emit();
        pokeAccount(id);
      });
    } finally {
      store.switching = false;
      store.switchingId = null;
      emit();
    }
  },

  async updateFromLive(id) {
    await guard(async () => {
      const r = await invoke("update_account_from_live", { id });
      toast(t("m.toastSynced", { name: r.name }), "ok", t("m.toastSyncedDetail"));
      await refresh(); emit();
    });
  },

  async exportOne(id) {
    await guard(async () => {
      const p = await invoke("export_pick_path", { id });
      if (!p.picked) { toast(t("m.exportCanceled")); return; }
      openPwModal({ mode: "export", id, path: p.path, name: p.name });
    });
  },

  async launch() {
    await guard(async () => {
      await invoke("launch_zcode");
      toast(t("m.launching"));
      setTimeout(() => actions.refresh(), 2500);
    });
  },

  askKill() {
    openConfirmModal({
      kind: "danger",
      icon: "power",
      title: t("m.killTitle"),
      yesLabel: t("m.killYes"),
      onYes: () => actions.doKill(),
    });
  },

  async doKill() {
    await guard(async () => {
      await invoke("kill_zcode");
      toast(t("m.toastKilled"));
      await refresh(); emit();
    });
  },

  acctQuota(id) {
    const dueAt = quotaDue[id];
    loadAcctQuota(id).then(() => {
      if (quotaDue[id] === dueAt) scheduleNext(id);
    });
  },

  // 全部账号额度手动刷新：仪表盘汇总栏入口。绕过 sweep 排程立即拉取，
  // 但尊重 loadAcctQuota 自身的 busy 防重入（在拉的不重复打）；拉完后
  // 重排各号 sweep 节奏，保持周期刷新不与手动拉取叠加
  refreshAllQuotas() {
    const ids = (store.state?.accounts || []).map((a) => a.id);
    let dueCount = 0;
    for (const id of ids) {
      if (store.acctQuota[id]?.busy) continue;
      dueCount++;
      const dueAt = quotaDue[id];
      loadAcctQuota(id).then(() => {
        if (quotaDue[id] === dueAt) scheduleNext(id);
      });
    }
    if (dueCount) emit();
    return dueCount;
  },

  async addAccount() {
    let providers;
    try { providers = await invoke("oauth_providers"); }
    catch (e) { toast(stripErr(e), "err"); return; }
    // 保存登录入口也收进这个弹窗：可用态与禁用原因跟工具栏旧按钮同口径
    const st = store.state;
    const activeAcc = st?.accounts?.find((a) => a.is_active) || null;
    openProviderModal({
      providers,
      canSaveLogin: !!st?.live_logged_in && !activeAcc,
      saveLoginTitle: activeAcc ? t("m.saveLoginDisabledTitle", { name: activeAcc.name }) : "",
      onSaveLogin: () => actions.capture(),
      onPick: async (id, browser) => {
        try {
          // 登录方式由弹窗 tab 决定（#40）：浏览器 = 外链 + 等待窗；内嵌 = 原有 webview 窗
          const r = await invoke("oauth_begin", { provider: id, browser });
          if (browser) openBrowserLoginModal({ url: r.authorize_url || "", provider: id });
          else toast(t("m.loginWindowOpened"), "ok", t("m.loginWindowDetail"));
        } catch (e) {
          toast(stripErr(e), "err");
        }
      },
    });
  },

  async claim(id) {
    // 单号融合领取：touch 重发投放 → 拿到就 claim_start（内部 touch 复核）→ 验证码/结果。
    // 不吃缓存——投放 TTL ~30s（11-17 实测），缓存版领取只会撞 claim.gone（两段式后半段全灭）
    const a = (store.state?.accounts || []).find((x) => x.id === id);
    const name = a?.name || id;
    if (claimActive || claimAllRunning || refreshClaim.running) { toast(t("m.claimBusy"), "warn"); return; }
    if (referralSideBusy()) { toast(t("m.captchaBusy"), "warn"); return; }
    if (!(await waitTouchIdle())) { toast(t("m.claimBusy"), "warn"); return; }
    if (claimActive || claimAllRunning || refreshClaim.running || autoClaimRunning || autoTouchRunning) return;
    claimActive = true;
    emit();
    try {
      let plans = [];
      try {
        store.claimable[id] = { ...(store.claimable[id] || {}), busy: true };
        emit();
        plans = (await invoke("claim_refresh_one", { id })) || [];
        store.claimable[id] = { plans, err: null, busy: false, refreshedAt: Date.now(), pending: plans.length ? null : ((await pendingCheckThrottled(id, true)) || null) };
      } catch (e) {
        const msg = stripErr(e);
        store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: msg, busy: false, refreshedAt: Date.now() + touchCooldownFor(id, msg) - REFRESH_CLAIM_COOLDOWN_MS };
        toast(t("m.refreshClaimAcctErr", { name, err: msg }), "warn");
        return; // touch 失败无从领取；429 冷却语义已入 refreshedAt
      }
      const plan = plans[0];
      if (!plan) { toast(t("m.refreshClaimOneEmpty", { name }), "ok", t("m.refreshClaimOneEmptyDetail")); return; }
      try {
        await invoke("claim_start", { id, planId: plan.plan_id });
      } catch (e) {
        toast(stripErr(e), "err");
        return;
      }
      toast(t("m.claimVerify", { name: plan.name || plan.plan_id }), "ok", t("m.claimVerifyDetail"));
      const r = await waitForClaimResult(id);
      if (!r) toast(t("m.claimTimeout"), "warn");
      // 领取失败按结构化字段分流退避（3012 倍增 / 业务限流固定 / HTTP 429），
      // 与自动领取同表——手动撞墙也计入倍增计数，冷却期内自动领取照常跳号
      if (r && r.ok === false) {
        autoClaimCooldown[id] = autoClaimCooldownFor(r);
        const waitMin = Math.max(1, Math.round((autoClaimCooldown[id] - Date.now()) / 60000));
        const rawBit = r.serverBody ? t("m.claimServerRaw", { raw: r.serverBody }) : "";
        toast(
          t("m.claimFailed", { name: r.accountName, code: Number.isFinite(r.code) && r.code >= 0 ? `[${r.code}] ` : "", msg: r.message || t("m.unknownErr") }),
          "err",
          [t("m.claimCooldownHint", { n: waitMin }), rawBit].filter(Boolean).join("\n")
        );
      }
    } finally {
      claimActive = false;
      emit();
    }
  },

  async claimAll() {
    // 融合「探测→领取」逐号推进：投放签发后约 30s 过期（11-17 实测，探测后 25s
    // 才轮到的号内部 touch 全部 claim.gone），两段式（先探测完一批再领取）后半段
    // 注定过期。每个号先 touch 重发投放，拿到就立刻提交，把「签发→提交」压回 5s 内
    const accounts = (store.state?.accounts || []).filter((a) => !skipReason(a));
    if (!accounts.length) { toast(t("m.noClaimableAccounts"), "warn"); return; }
    if (claimActive || claimAllRunning || refreshClaim.running) return;
    if (!(await waitTouchIdle())) { toast(t("m.claimBusy"), "warn"); return; }
    if (!(await waitClaimIdle())) { toast(t("m.claimBusy"), "warn"); return; }
    if (claimActive || claimAllRunning || refreshClaim.running || autoClaimRunning || autoTouchRunning) return;
    if (referralSideBusy()) { toast(t("m.captchaBusy"), "warn"); return; }
    claimAllRunning = true;
    claimActive = true;
    emit();
    // 防 429：基础间隔 2.6s + 抖动；命中 429（claim_start 异常或结果 message 带 429）
    // 指数退避 15s→30s→60s→封顶 120s，未再命中即清零
    let backoffMs = 0;
    const hit429 = (s) => String(s || "").includes("429");
    let claimed = 0, noDelivery = 0;
    const failBits = [];
    try {
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[i];
        const id = a.id;
        const name = a.name || id;
        if (i > 0) await new Promise((res) => setTimeout(res, 2600 + Math.random() * 1200 + backoffMs));
        let plans = [];
        try {
          store.claimable[id] = { ...(store.claimable[id] || {}), busy: true };
          emit();
          plans = (await invoke("claim_refresh_one", { id })) || [];
          store.claimable[id] = { plans, err: null, busy: false, refreshedAt: Date.now(), pending: plans.length ? null : ((await pendingCheckThrottled(id)) || null) };
        } catch (e) {
          const msg = stripErr(e);
          store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: msg, busy: false, refreshedAt: Date.now() };
          if (hit429(msg)) {
            backoffMs = Math.min(backoffMs ? backoffMs * 2 : 15000, 120000);
            toast(t("m.claimAllThrottle", { name, n: Math.round(backoffMs / 1000) }), "warn");
          } else {
            failBits.push(`${name}: ${msg}`);
          }
          continue; // touch 失败的号本轮无从领取，冷却语义由 touch 侧表管
        }
        const plan = plans[0];
        if (!plan) { noDelivery++; continue; }
        let q429 = false;
        try {
          await invoke("claim_start", { id, planId: plan.plan_id });
        } catch (e) {
          // 429 时验证码窗还没开，不补 claim_cancel，直接走退避
          q429 = hit429(stripErr(e));
          if (!q429) failBits.push(`${name}: ${stripErr(e)}`);
        }
        if (!q429) {
          const r = await waitForClaimResult(id, 120000);
          if (!r) {
            failBits.push(`${name}: ${t("m.claimAcctTimeout", { name })}`);
            await invoke("claim_cancel").catch(() => {});
          } else if (r.ok === true) {
            claimed++;
            await awaitClaimableFresh(id);
          } else if (hit429(r.message)) {
            q429 = true;
          } else {
            failBits.push(`${name}: [${Number.isFinite(r.code) && r.code >= 0 ? r.code : "?"}] ${r.message || t("m.unknownErr")}`);
          }
        }
        if (q429) {
          backoffMs = Math.min(backoffMs ? backoffMs * 2 : 15000, 120000);
          toast(t("m.claimAllThrottle", { name, n: Math.round(backoffMs / 1000) }), "warn");
        } else {
          backoffMs = 0;
        }
        emit();
      }
    } finally {
      claimAllRunning = false;
      claimActive = false;
      emit();
    }
    toast(
      t("m.claimAllDone", { n: accounts.length, k: claimed, g: noDelivery }),
      failBits.length ? "warn" : "ok",
      failBits.join("\n"),
    );
  },

  // 单号探测：与批量 refreshClaim 同一后端命令（claim_refresh_one = touch 投放清单，
  // preview 通道已删），但不占批量冷却；批量/领取/自动 touch 在跑时拒绝，避免叠加请求撞风控
  async refreshClaimOne(id) {
    if (refreshOneBusy || refreshClaim.running || claimActive) { toast(t("m.claimBusy"), "warn"); return; }
    if (!(await waitTouchIdle())) { toast(t("m.claimBusy"), "warn"); return; }
    if (refreshOneBusy || refreshClaim.running || claimActive) return;
    if (store.claimable[id]?.busy) return;
    // 与批量同口径：60s 内刷过的号不再重查（叠加请求撞风控）
    if (Date.now() - (store.claimable[id]?.refreshedAt || 0) < REFRESH_CLAIM_COOLDOWN_MS) {
      // 提示按剩余秒数算：429 退避把 refreshedAt 前置到未来，elapsed 会是负数
      const n = Math.max(1, Math.ceil(((store.claimable[id]?.refreshedAt || 0) + REFRESH_CLAIM_COOLDOWN_MS - Date.now()) / 1000));
      toast(t("m.refreshFreshSkip", { name: accountName(id), n }), "warn");
      return;
    }
    const name = accountName(id);
    store.claimable[id] = { plans: store.claimable[id]?.plans || [], busy: true };
    refreshOneBusy = true;
    emit();
    try {
      const plans = (await invoke("claim_refresh_one", { id })) || [];
      touch429Count[id] = 0; // 成功即回退基准：下次 429 从 60s 重爬（与退避表注释口径一致）
      store.claimable[id] = { plans, err: null, busy: false, refreshedAt: Date.now() };
      if (plans.length) {
        store.claimable[id].pending = null;
        toast(t("m.refreshClaimOneDone", { name, n: plans.length }), "ok");
        maybeAutoClaimAfterTouch();
      } else {
        // 手动单号探测 = 用户主动要最新状态，强制绕过节流
        const pending = await pendingCheckThrottled(id, true);
        store.claimable[id].pending = pending || null;
        // touch 空时拉领取历史区分两种空：已领取过（touch 不再下发）vs 真没投放
        await loadClaimHistory(id);
        const claimedBefore = (store.claimHistory[id]?.history || []).length > 0;
        if (pending) {
          toast(t("m.claimPendingToast", { name, plan: pending.planName }), "ok");
        } else if (claimedBefore) {
          // 已领取过：touch 不再下发属正常，别误报「活动已结束」
          toast(t("m.refreshClaimOneClaimed", { name, n: (store.claimHistory[id]?.history || []).length }), "ok");
        } else {
          toast(t("m.refreshClaimOneEmpty", { name }), "ok", t("m.refreshClaimOneEmptyDetail"));
        }
      }
    } catch (e) {
      const msg = stripErr(e);
      // touch 429 上抛：失败也进冷却（此前 catch 不写 refreshedAt，用户立刻再点立刻再撞），
      // 429 连续命中指数升级（60s→2min→…→15min 封顶），非 429 失败回退基准
      store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: msg, busy: false, refreshedAt: Date.now() + touchCooldownFor(id, msg) - REFRESH_CLAIM_COOLDOWN_MS };
      toast(t("m.refreshClaimAcctErr", { name, err: msg }), "err");
    }
    scheduleNext(id);
    refreshOneBusy = false;
    emit();
  },

  async refreshClaim() {
    const accounts = store.state?.accounts || [];
    const now0 = Date.now();
    // 失败号复用自动领取的冷却表：冷却期内重试必然同码失败，白打请求
    const cooled = (id) => (autoClaimCooldown[id] ?? 0) > now0;
    // per-id 新近已刷新跳过：60s 内刷过的号（refreshedAt）批量时不再重查
    // ——叠加请求就是领取链 429→3012 的同款场景
    const fresh = (id) => now0 - (store.claimable[id]?.refreshedAt || 0) < REFRESH_CLAIM_COOLDOWN_MS;
    // 已有可领套餐的号不再单独跳过：fresh 一层管够——60s 内刷过的（无论结果）一律不重查
    // （活徽章防波动覆盖、空结果不浪费请求）；领取失败（gone/1002）不写缓存，死 plans 会
    // 留在缓存里，此前 hasPlans 无条件跳过让死徽章挂满 10 分钟冷却期（点领取必弹 gone），
    // 过期缓存放行重查即可自愈。要验证某个套餐是否还在用单号刷新（真实覆盖）
    const ids = accounts
      .filter((a) => !skipReason(a))
      .map((a) => a.id)
      .filter((id) => !cooled(id))
      .filter((id) => !fresh(id));
    const skippedBits = [
      ...accounts.filter((a) => skipReason(a)).map((a) => `${a.name}（${skipReason(a)}）`),
      ...accounts
        .filter((a) => !skipReason(a) && cooled(a.id))
        .map((a) => `${a.name}（${t("m.skipCooldown", { n: Math.ceil((autoClaimCooldown[a.id] - now0) / 60000) })}）`),
      ...accounts
        .filter((a) => !skipReason(a) && !cooled(a.id) && fresh(a.id))
        .map((a) => `${a.name}（${t("m.refreshFreshSkip")}）`),
    ];
    if (!ids.length) {
      toast(t("m.claimSkippedAll", { names: skippedBits.join("、") }), "warn");
      return;
    }
    const now = Date.now();
    if (refreshOneBusy || refreshClaim.running || claimAllRunning || (claimActive && !autoClaimRunning)) {
      toast(t("m.claimBusy"), "warn");
      return;
    }
    if (!(await waitTouchIdle())) { toast(t("m.claimBusy"), "warn"); return; }
    if (refreshOneBusy || refreshClaim.running || claimAllRunning || (claimActive && !autoClaimRunning)) return;
    if (now < refreshClaim.cooldownUntil) {
      toast(t("btn.refreshClaimCooldownTitle", { n: Math.ceil((refreshClaim.cooldownUntil - now) / 1000) }), "warn");
      return;
    }
    refreshClaim = { running: true, done: 0, total: ids.length, cooldownUntil: 0 };
    startRefreshTicker();
    emit();
    if (autoClaimRunning || autoTouchRunning) {
      autoAbortRequested = true;
      const deadline = Date.now() + AUTO_ABORT_WAIT_MS;
      while ((autoClaimRunning || autoTouchRunning) && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 300));
      }
      if (autoClaimRunning || autoTouchRunning) {
        refreshClaim.running = false;
        refreshClaim.cooldownUntil = Date.now() + REFRESH_CLAIM_COOLDOWN_MS;
        toast(t("m.claimBusy"), "warn");
        setTimeout(stopRefreshTickerIfIdle, 1100);
        return;
      }
    }
    let okCount = 0;
    const failBits = [];
    try {
      let done = 0;
      // 手动探测同样 60s 批间隔，与自动轮一致的错峰密度
      await refreshClaimBatch(ids, 60_000, async (id) => {
        const name = store.state.accounts.find((a) => a.id === id)?.name || id;
        refreshClaim.done = ++done;
        store.claimable[id] = { plans: store.claimable[id]?.plans || [], busy: true };
        emit();
        try {
          const plans = (await invoke("claim_refresh_one", { id })) || [];
          touch429Count[id] = 0; // 成功即回退基准：下次 429 从 60s 重爬
          store.claimable[id] = { plans, err: null, busy: false, refreshedAt: Date.now() };
          if (plans.length) {
            store.claimable[id].pending = null;
            okCount++;
            // 融合跟领（自动领取开着时）：60s 批间隔铺完全场要 7-9min，投放置顶 30s
            // 过期——等批末统一领取时只有最后几个号还活着，必须 touch 到就排队领
            enqueueAutoClaim(id);
          } else {
            // 批量也补待生效判定：领取后 touch 不再下发，balance 反推「已领取（待生效）」。
            // 批量走节流——没投放的号每轮都打 balance 就是双倍上游请求
            store.claimable[id].pending = await pendingCheckThrottled(id) || null;
          }
        } catch (e) {
          const msg = stripErr(e);
          // touch 429 上抛：失败也进冷却（refreshedAt 语义对齐其余路径），429 连续命中指数升级
          store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: msg, busy: false, refreshedAt: Date.now() + touchCooldownFor(id, msg) - REFRESH_CLAIM_COOLDOWN_MS };
          failBits.push(`${name}: ${msg}`);
        }
        scheduleNext(id);
        emit();
      });
    } finally {
      refreshClaim.running = false;
      refreshClaim.cooldownUntil = Date.now() + REFRESH_CLAIM_COOLDOWN_MS;
      emit();
      setTimeout(stopRefreshTickerIfIdle, 1100);
    }
    maybeAutoClaimAfterTouch();
    // 每号失败不再逐条弹：聚进汇总 detail；批量跳过的号也列在这里
    toast(
      t("m.refreshClaimDone", { n: ids.length, k: okCount }),
      failBits.length ? "warn" : "ok",
      [...skippedBits.map((s) => t("m.refreshClaimSkipped", { name: s })), ...failBits].join("\n"),
    );
  },

  async referralBind(id, code) {
    if (referralBindRunning) { toast(t("m.referralBusy"), "warn"); return; }
    if (claimSideBusy()) { toast(t("m.captchaBusy"), "warn"); return; }
    const c = (code || "").trim().toUpperCase();
    if (!c) { toast(t("m.referralCodeNeeded"), "warn"); return; }
    referralBindRunning = true;
    const name = accountName(id);
    try {
      await invoke("referral_bind_start", { id, inviteCode: c });
      toast(t("m.referralVerify", { name, code: c }), "ok", t("m.referralVerifyDetail"));
      const r = await waitForReferralResult(id);
      if (!r) {
        await invoke("referral_bind_cancel").catch(() => {});
        toast(t("m.referralTimeout"), "warn");
      } else if (r.ok === false) {
        if (r.code === "closed") toast(t("m.referralCancelled"), "warn");
        else toast(t("m.referralFailed", { name, msg: r.message || t("m.unknownErr") }), "err");
      } else {
        toast(t("m.referralOk", { name, code: c }), "ok");
      }
      loadReferral(id);
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      referralBindRunning = false;
    }
  },

  async toggleAutoClaim() {
    if (autoToggleBusy) return;
    const next = !store.state.auto_claim;
    if (next && (refreshOneBusy || autoClaimRunning || claimActive || claimAllRunning || refreshClaim.running)) {
      toast(t("m.claimBusy"), "warn");
      return;
    }
    autoToggleBusy = true;
    // 乐观翻转：开关即时到位，落盘/对齐在后台跑（set_behavior 可能排队等 STORE_LOCK）
    store.state.auto_claim = next;
    emit();
    try {
      await invoke("set_behavior", { autoClaim: next });
      await refresh();
      emit();
      if (store.state.auto_claim) {
        toast(t("m.autoClaimOn"), "ok", t("m.autoClaimOnDetail"));
        if (Date.now() - (lastAutoRound?.at ?? 0) > REFRESH_CLAIM_COOLDOWN_MS) {
          // 开启即检测：touch 开着先查一轮填缓存，随后消费（touch 关则直接领缓存）
          autoTouchTick().then(() => autoClaimTick());
        }
      } else {
        lastAutoRound = null;
      }
    } catch (e) {
      store.state.auto_claim = !next;
      emit();
      toast(stripErr(e), "err");
    } finally { autoToggleBusy = false; }
  },
};

// ---- 运行标志（供渲染层读取） ----
export function runtimeFlags() {
  return { claimAllRunning, refreshClaim, claimActive, autoClaimRunning, autoTouchRunning };
}

// ---- Tauri 事件接线（boot 时挂一次） ----
export function wireEvents() {
  listen("tray-action", (ev) => {
    const p = ev.payload || {};
    if (p.action === "capture" && p.ok) toast(t("m.toastSaved", { name: p.result.name }));
    else if (!p.ok && p.error) toast(p.error, "err");
    refresh().then(() => { emit(); enrollAccounts(); }).catch(() => {});
  });

  listen("claim://result", (ev) => {
    const p = ev.payload || {};
    if (claimWaiter && claimWaiter.accountId === p.accountId) claimWaiter.finish(p);
    if (p.ok === false) {
      let msg = p.message || t("m.unknownErr");
      // 业务码直接亮出来（-1 = 网络/解析错误，无码可示）
      const codeBit = Number.isFinite(p.code) && p.code >= 0 ? `[${p.code}] ` : "";
      if (p.nextAt) {
        msg += t("m.claimNextAt", { time: new Date(p.nextAt).toLocaleString(localeTag(), { hour12: false }) });
      }
      const rawBit = p.serverBody ? t("m.claimServerRaw", { raw: p.serverBody }) : "";
      toast(t("m.claimFailed", { name: p.accountName, code: codeBit, msg }), "err", rawBit);
    } else {
      const bits = [];
      const now = p.serverTime || Date.now();
      // 生效时间三级取值（对齐上游 v1.7.4 语义）：effective_at 权威 → 缺失时拿 starts_at
      // 兜底但标注来源 → 时间统一 YYYY-MM-DD HH:mm（不带秒，带年份）。
      // effectiveAt 0 = 立即生效；startsAt 在 now 之前属于已生效，不再显示
      const fmt = (ts) => {
        const d = new Date(ts);
        const p2 = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      };
      if (p.effectiveAt === 0) {
        bits.push(t("m.claimEffectiveNow"));
      } else if (p.effectiveAt) {
        bits.push(t("m.claimEffectiveAt", { time: fmt(p.effectiveAt) }));
      } else if (p.startsAt && p.startsAt > now) {
        // 权威字段缺失：活动开始时间只能当预估，文案标注「据活动说明」，不冒充生效时间
        bits.push(t("m.claimStartsAt", { time: fmt(p.startsAt) }));
      }
      if (p.endsAt) bits.push(t("m.claimEndsAt", { time: fmt(p.endsAt) }));
      toast(t("m.claimOk", { name: p.accountName, plan: p.planName }), "ok", bits.join(t("common.listSep")));
    }
    if (p.accountId) {
      // 领取结果落地后服务端状态已变（待生效/桶下发），解冻节流让下次刷新拿到真实判定
      if (p.ok !== false) delete pendingCheckAt[p.accountId];
      loadAcctQuota(p.accountId);
      // 领取成功后历史立即刷新（本地文件读取，零上游流量），账号行「已领取过」展示用
      if (p.ok !== false) loadClaimHistory(p.accountId);
      if (!autoClaimRunning) {
        loadClaimPreview(p.accountId).then(() => emit());
      }
      scheduleNext(p.accountId);
    }
  });

  listen("referral://result", (ev) => {
    const p = ev.payload || {};
    if (referralWaiter && referralWaiter.accountId === p.accountId) referralWaiter.finish(p);
  });

  // 用户手动关掉验证码窗口：后端已清 pending，这里让两侧 waiter 立即结束
  listen("captcha://closed", () => {
    if (claimWaiter) claimWaiter.finish({ ok: false, code: "closed" });
    if (referralWaiter) referralWaiter.finish({ ok: false, code: "closed" });
  });

  listen("captcha://interactive", () => {
    if (referralWaiter && !claimWaiter && !autoClaimRunning) {
      // 无感验证失败≠绑码失败：窗口留着，手动过滑块后 submit 仍会派发到 bind 分支
      toast(t("m.referralInteractive"), "warn", t("m.referralInteractiveDetail"));
      return;
    }
    if (!autoClaimRunning || !claimWaiter) return;
    const id = claimWaiter.accountId;
    invoke("claim_cancel").catch(() => {});
    autoClaimCooldown[id] = Date.now() + 60 * 60 * 1000;
    toast(t("m.autoClaimInteractive", { name: accountName(id) }), "warn", t("m.autoClaimInteractiveDetail"));
    claimWaiter.finish({ ok: false, code: "interactive" });
  });

  listen("oauth://done", (ev) => {
    const p = ev.payload || {};
    if (p.ok === false) {
      if (p.soft) {
        // 软失败（误点的 deep link 回调等）：流程还挂着 poll，等待窗不关
        toast(t("m.oauthSoft", { err: p.error || t("m.unknownErr") }), "warn", t("m.oauthSoftDetail"));
        return;
      }
      closeBrowserLoginModal();
      toast(t("m.oauthFail", { err: p.error || t("m.unknownErr") }), "err");
      return;
    }
    closeBrowserLoginModal();
    if (p.duplicate) {
      toast(t("m.oauthDup", { name: p.name }), "warn", t("m.oauthDupDetail"));
      return;
    }
    toast(t("m.oauthOk", { name: p.name }), "ok", t("m.oauthOkDetail"));
    refresh().then(() => { emit(); enrollAccounts(); }).catch(() => {});
  });

  listen("state-changed", () => {
    refresh().then(() => emit()).catch(() => {});
  });
}

// ---- 启动（由 App 的 useEffect 调一次） ----
let booted = false;
export async function boot() {
  if (booted) return;
  booted = true;
  wireEvents();
  try {
    store.appVer = await invoke("app_version").catch(() => "");
    await refresh();
    emit();
    await invoke("reveal_main");
    setTimeout(dismissSplashSafe, 350);
    enrollAccounts();
    sweepTick();
    setInterval(() => {
      invoke("get_state").then((raw) => { const s = patchLang(raw); store.state = s; if (s?.language) syncLang(s.language); enrollAccounts(); emit(); }).catch(() => {});
    }, 5000);
    setInterval(sweepTick, TICK_MS);
    setTimeout(silentUpdateCheck, BOOT_UPDATE_CHECK_MS);
    // 错相启动：touch 首跳 2min；claim 首跳 7min（+半周期），稳态相位差恒 5min
    scheduleTouch(AUTO_CLAIM_FIRST_DELAY_MS);
    scheduleClaim(AUTO_CLAIM_FIRST_DELAY_MS + AUTO_CLAIM_INTERVAL_MS / 2);
  } catch (e) {
    store.bootError = stripErr(e);
    emit();
    invoke("reveal_main").catch(() => {});
    dismissSplashSafe();
  }
}

import { dismissSplash } from "../components/ui-bus.js";
function dismissSplashSafe() { dismissSplash(); }
