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
  acctQuota: {},        // id -> {data?, err?, busy}
  claimable: {},        // id -> {plans?, err?, busy}
  referral: {},         // id -> {summary?, invitees?, err?, busy}
};

let busy = false;
let claimAllRunning = false;
const REFRESH_CLAIM_COOLDOWN_MS = 60_000;
let refreshClaim = { running: false, done: 0, total: 0, cooldownUntil: 0 };
let refreshTicker = null;

const AUTO_CLAIM_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_CLAIM_FIRST_DELAY_MS = 2 * 60 * 1000;
// 启动后延迟做更新检查：等窗口起来、splash 散去再弹提示，不跟开机首屏抢注意力
const BOOT_UPDATE_CHECK_MS = 15_000;
const AUTO_CLAIM_WAIT_MS = 45_000;
const AUTO_CLAIM_PER_ACCOUNT_CAP = 5;
const AUTO_CLAIM_ACCT_GAP_MS = 5_000;
const AUTO_ABORT_WAIT_MS = 90_000;
let autoClaimRunning = false;
const autoClaimCooldown = {};
let autoAbortRequested = false;
let claimActive = false;
let lastAutoRound = null;
let autoToggleBusy = false;

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
  try {
    await fn();
  } catch (e) {
    toast(stripErr(e), "err");
  } finally {
    busy = false;
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

async function loadClaimPreview(id) {
  const cur = store.claimable[id] || {};
  if (cur.busy) return;
  store.claimable[id] = { plans: cur.plans || [], busy: true };
  try {
    const plans = await invoke("claim_preview", { id });
    store.claimable[id] = { plans: plans || [], err: null, busy: false };
  } catch (e) {
    store.claimable[id] = { plans: cur.plans || [], err: String(e), busy: false };
  }
}

// ---- referral 邀请 ----
let referralWaiter = null;
let referralBindRunning = false;

// 验证码窗口是 claim/bind 共用的单一资源：后端在任一侧发起时清掉对方 pending，
// 前端一侧进行时另一侧直接拒绝，避免被清方的 waiter 干等 90s 超时
const claimSideBusy = () => !!(claimWaiter || claimActive || claimAllRunning || refreshClaim.running || autoClaimRunning);
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

async function awaitClaimPreviewFresh(id) {
  store.claimable[id] = { ...(store.claimable[id] || {}), busy: true };
  try {
    const plans = await invoke("claim_preview", { id });
    store.claimable[id] = { plans: plans || [], err: null, busy: false };
  } catch (e) {
    store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: String(e), busy: false };
  }
}

export const accountName = (id) => (store.state?.accounts || []).find((a) => a.id === id)?.name || id;

export function autoPillTitle(s) {
  const bits = [t("btn.autoClaimTitle")];
  if (autoClaimRunning) bits.push(t(s.auto_claim ? "m.autoClaimRound" : "m.autoClaimStopping"));
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
function autoClaimCooldownFor(r) {
  const now = Date.now();
  if (r.code === 1005 && r.nextAt) return r.nextAt;
  if (Number.isFinite(r.code) && r.code >= 1000) return now + 60 * 60 * 1000;
  if (r.code === "interactive") return now + 60 * 60 * 1000;
  return now + AUTO_CLAIM_INTERVAL_MS;
}

async function autoClaimTick() {
  if (!store.state?.auto_claim || autoClaimRunning) return;
  if (claimActive || claimAllRunning || refreshClaim.running) return;
  const ids = (store.state.accounts || [])
    .map((a) => a.id)
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
    for (const id of ids) {
      if (!store.state?.auto_claim || autoAbortRequested) break;
      if (!(store.state.accounts || []).some((a) => a.id === id)) continue;
      let gotAny = false;
      store.claimable[id] = { ...(store.claimable[id] || {}), busy: true };
      try {
        const r = await invoke("claim_refresh", { id });
        store.claimable[id] = { plans: r.plans || [], err: null, busy: false };
      } catch (e) {
        store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: String(e), busy: false };
        autoClaimCooldown[id] = Date.now() + AUTO_CLAIM_INTERVAL_MS;
        roundSkipped++;
        continue;
      }
      emit();
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
        gotAny = true; roundClaimed++;
        await awaitClaimPreviewFresh(id);
        emit();
        progressed = true;
        await new Promise((res) => setTimeout(res, 1200));
      }
      if (!gotAny && (store.claimable[id]?.plans || []).length) roundSkipped++;
      await new Promise((res) => setTimeout(res, AUTO_CLAIM_ACCT_GAP_MS));
    }
  } finally {
    autoClaimRunning = false; claimActive = false;
    if (store.state?.auto_claim) lastAutoRound = { at: Date.now(), claimed: roundClaimed, skipped: roundSkipped };
    emit();
  }
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
        const probeBad = r.probe && r.probe.kind !== "entitled";
        if (probeBad) {
          bits.push(t(r.probe.kind === "no_entitlement" ? "m.bitProbeNoPlan" : "m.bitProbeAuthFailed"));
        }
        toast(t("m.toastSwitched", { name: r.name }), (r.config_stale || probeBad) ? "warn" : "ok", bits.join(t("common.listSep")));
      }
      await refresh(); emit();
      pokeAccount(id);
    });
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
    if (claimActive || claimAllRunning || refreshClaim.running) { toast(t("m.claimBusy"), "warn"); return; }
    if (referralSideBusy()) { toast(t("m.captchaBusy"), "warn"); return; }
    const plans = store.claimable[id]?.plans || [];
    const plan = plans[0];
    if (!plan) { toast(t("m.noClaimable"), "warn"); return; }
    claimActive = true;
    emit();
    try {
      await invoke("claim_start", { id, planId: plan.plan_id });
      toast(t("m.claimVerify", { name: plan.name || plan.plan_id }), "ok", t("m.claimVerifyDetail"));
      const r = await waitForClaimResult(id);
      if (!r) toast(t("m.claimTimeout"), "warn");
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      claimActive = false;
      emit();
    }
  },

  async claimAll() {
    const ids = (store.state?.accounts || [])
      .map((a) => a.id)
      .filter((id) => (store.claimable[id]?.plans || []).length > 0);
    if (!ids.length) { toast(t("m.noClaimableAccounts"), "warn"); return; }
    if (claimActive || claimAllRunning || refreshClaim.running) return;
    if (referralSideBusy()) { toast(t("m.captchaBusy"), "warn"); return; }
    claimAllRunning = true;
    claimActive = true;
    emit();
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const plan = store.claimable[id]?.plans?.[0];
        if (!plan) continue; // 刷新可能在排队期间清空了该账号的 plans
        const name = store.state.accounts.find((a) => a.id === id)?.name || id;
        try {
          await invoke("claim_start", { id, planId: plan.plan_id });
        } catch (e) {
          toast(t("m.claimAccountErr", { name, err: stripErr(e) }), "err");
          continue;
        }
        const r = await waitForClaimResult(id, 120000);
        if (!r) {
          toast(t("m.claimAcctTimeout", { name }), "warn");
          await invoke("claim_cancel").catch(() => {});
        }
        if (i < ids.length - 1) await new Promise((res) => setTimeout(res, 1200));
      }
    } finally {
      claimAllRunning = false;
      claimActive = false;
      emit();
    }
  },

  async refreshClaim() {
    const ids = (store.state?.accounts || []).map((a) => a.id);
    if (!ids.length) return;
    const now = Date.now();
    if (refreshClaim.running || claimAllRunning || (claimActive && !autoClaimRunning)) return;
    if (now < refreshClaim.cooldownUntil) {
      toast(t("btn.refreshClaimCooldownTitle", { n: Math.ceil((refreshClaim.cooldownUntil - now) / 1000) }), "warn");
      return;
    }
    refreshClaim = { running: true, done: 0, total: ids.length, cooldownUntil: 0 };
    startRefreshTicker();
    emit();
    if (autoClaimRunning) {
      autoAbortRequested = true;
      const deadline = Date.now() + AUTO_ABORT_WAIT_MS;
      while (autoClaimRunning && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 300));
      }
      if (autoClaimRunning) {
        refreshClaim.running = false;
        refreshClaim.cooldownUntil = Date.now() + REFRESH_CLAIM_COOLDOWN_MS;
        toast(t("m.claimBusy"), "warn");
        setTimeout(stopRefreshTickerIfIdle, 1100);
        return;
      }
    }
    let okCount = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const name = store.state.accounts.find((a) => a.id === id)?.name || id;
        refreshClaim.done = i + 1;
        store.claimable[id] = { plans: store.claimable[id]?.plans || [], busy: true };
        emit();
        try {
          const r = await invoke("claim_refresh", { id });
          store.claimable[id] = { plans: r.plans || [], err: null, busy: false };
          if ((r.plans || []).length) okCount++;
          if (r.activationError) toast(t("m.refreshClaimAcctErr", { name, err: stripErr(r.activationError) }), "warn");
        } catch (e) {
          store.claimable[id] = { plans: store.claimable[id]?.plans || [], err: String(e), busy: false };
          toast(t("m.refreshClaimAcctErr", { name, err: stripErr(e) }), "err");
        }
        scheduleNext(id);
        emit();
        if (i < ids.length - 1) await new Promise((res) => setTimeout(res, 5000));
      }
    } finally {
      refreshClaim.running = false;
      refreshClaim.cooldownUntil = Date.now() + REFRESH_CLAIM_COOLDOWN_MS;
      emit();
      setTimeout(stopRefreshTickerIfIdle, 1100);
    }
    toast(t("m.refreshClaimDone", { n: ids.length, k: okCount }), "ok");
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
    if (next && (autoClaimRunning || claimActive || claimAllRunning || refreshClaim.running)) {
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
        if (Date.now() - (lastAutoRound?.at ?? 0) > REFRESH_CLAIM_COOLDOWN_MS) autoClaimTick();
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
  return { claimAllRunning, refreshClaim, claimActive, autoClaimRunning };
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
      if (p.code === 1005 && p.nextAt) {
        msg += t("m.claimNextAt", { time: new Date(p.nextAt).toLocaleString(localeTag(), { hour12: false }) });
      }
      toast(t("m.claimFailed", { name: p.accountName, msg }), "err");
    } else {
      const bits = [];
      const now = p.serverTime || Date.now();
      if (p.startsAt && p.startsAt > now) bits.push(t("m.claimStartsAt", { time: new Date(p.startsAt).toLocaleString(localeTag(), { hour12: false }) }));
      if (p.endsAt) bits.push(t("m.claimEndsAt", { time: new Date(p.endsAt).toLocaleString(localeTag(), { hour12: false }) }));
      toast(t("m.claimOk", { name: p.accountName, plan: p.planName }), "ok", bits.join(t("common.listSep")));
    }
    if (p.accountId) {
      loadAcctQuota(p.accountId);
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
    setTimeout(autoClaimTick, AUTO_CLAIM_FIRST_DELAY_MS);
    setInterval(autoClaimTick, AUTO_CLAIM_INTERVAL_MS);
  } catch (e) {
    store.bootError = stripErr(e);
    emit();
    invoke("reveal_main").catch(() => {});
    dismissSplashSafe();
  }
}

import { dismissSplash } from "../components/ui-bus.js";
function dismissSplashSafe() { dismissSplash(); }
