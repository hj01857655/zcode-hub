// App.jsx — 渲染层根组件。class 名与 DOM 层级保持与原 innerHTML 模板一致，CSS 无需改动。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Ic } from "./components/iconsx.jsx";
import { init, t, beginLangSync, endLangSync } from "./lib/i18n.js";
import { currentTheme, setTheme } from "./lib/theme.js";
import {
  store, subscribe, getVersion, boot, actions, runtimeFlags, emit,
  notchColor, autoPillTitle, accountName,  // eslint-disable-line no-unused-vars
} from "./lib/store.js";
import { expireInfo, tierBadges } from "./lib/quotaView.js";
import { toast } from "./components/ui-bus.js";
import { stripErr } from "./lib/i18n.js";
import { AccountQuotaSlot, TierBadges } from "./components/QuotaView.jsx";
import SettingsPage from "./views/settings.jsx";
import AboutPage from "./views/about.jsx";
import GatewayPage from "./views/gateway.jsx";
import GatewayLogsPage from "./views/gateway-logs.jsx";
import ReferralPage from "./views/referral.jsx";
import DashboardPage from "./views/dashboard.jsx";
import { quotaTotals, fmtTokens } from "./lib/quotaView.js";

function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store;
}

function SideNav({ view, setView, s, unsaved }) {
  const [theme, setThemeState] = useState(currentTheme);
  // setTheme 只广播事件不回调，这里监听同步本地图标状态
  useEffect(() => {
    const f = () => setThemeState(currentTheme());
    window.addEventListener("zcs-theme", f);
    return () => window.removeEventListener("zcs-theme", f);
  }, []);
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");
  const toggleLang = () => {
    const next = (s.language || "zh").startsWith("zh") ? "en" : "zh";
    // 先翻 UI 再异步落盘：set_language 要抢 store_guard，赶上切换/保存就得等，不该挡住界面
    store.state.language = next;
    beginLangSync(next);
    init(next);
    emit();
    invoke("set_language", { lang: next })
      .finally(endLangSync)
      .catch(() => {
        // 状态栏静默：落盘失败回滚 UI
        store.state.language = s.language || "zh";
        init(store.state.language);
        emit();
      });
  };
  // 状态只以点呈现（运行=绿 / 已登录=灰白 / 未登录=暗），文字进悬停提示
  const dotCls = s.zcode_running ? "run" : s.live_logged_in ? "" : "off";
  const statusTip = s.zcode_running
    ? t("m.status.running")
    : s.live_logged_in
      ? unsaved ? t("m.status.unsaved") : t("m.status.safe")
      : t("m.status.loggedOut");
  return (
    <aside className="sidenav">
      <div className="side-logo">
        Z·HUB{store.appVer ? <span className="ver" title={`v${store.appVer}`}>v{store.appVer.split(".").slice(0, 3).join(".")}</span> : null}
      </div>
      <button
        className={"side-item" + (view === "dashboard" ? " on" : "")}
        onClick={() => setView("dashboard")}
      >
        <Ic name="gauge" size={16} /> {t("d.menu")}
      </button>
      <button
        className={"side-item" + (view === "accounts" ? " on" : "")}
        onClick={() => setView("accounts")}
      >
        <Ic name="list" size={16} /> {t("m.accounts")}
      </button>
      <button
        className={"side-item" + (view === "gateway" ? " on" : "")}
        onClick={() => setView("gateway")}
      >
        <Ic name="swap" size={16} /> {t("x.menuLabel")}
      </button>
      <button
        className={"side-item" + (view === "gatewayLogs" ? " on" : "")}
        onClick={() => setView("gatewayLogs")}
      >
        <Ic name="list" size={16} /> {t("xl.menuLabel")}
      </button>
      <button
        className={"side-item" + (view === "referral" ? " on" : "")}
        onClick={() => setView("referral")}
      >
        <Ic name="link" size={16} /> {t("r.menu")}
      </button>
      <button
        className={"side-item" + (view === "settings" ? " on" : "")}
        onClick={() => setView("settings")}
      >
        <Ic name="sliders" size={16} /> {t("common.settings")}
      </button>
      <button
        className={"side-item" + (view === "about" ? " on" : "")}
        onClick={() => setView("about")}
      >
        <Ic name="empty" size={16} /> {t("a.menuLabel")}
      </button>
      <div className="side-spacer" />
      <div className="side-foot">
        <span className={"status-dot " + dotCls} title={statusTip} />
        <span className="side-quick">
          <button className="side-qbtn" title={t("m.quickTheme")} aria-label={t("m.quickTheme")} onClick={toggleTheme}>
            <Ic name={theme === "dark" ? "sun" : "moon"} size={14} />
          </button>
          <button className="side-qbtn" title={t("m.quickLang")} aria-label={t("m.quickLang")} onClick={toggleLang}>
            {(s.language || "zh").startsWith("zh") ? "EN" : "中"}
          </button>
        </span>
      </div>
    </aside>
  );
}

function Toolbar({ s, active, claimableCount }) {
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const cooling = Date.now() < refreshClaim.cooldownUntil;
  return (
    <section className="toolbar">
      {claimableCount > 0 ? (
        <button
          className="btn-ghost has-ic claim-all"
          onClick={() => actions.claimAll()}
          disabled={claimAllRunning || refreshClaim.running || autoClaimRunning}
          title={t("btn.claimAllTitle")}
        >
          <Ic name="gift" size={16} /> {t("btn.claimAll")}
          {claimableCount > 1 ? ` (${claimableCount})` : ""}
        </button>
      ) : null}

      {s.accounts.length > 0 ? (
        <button
          className="btn-ghost has-ic"
          onClick={() => actions.refreshClaim()}
          disabled={refreshClaim.running || claimAllRunning || cooling}
          title={cooling && !refreshClaim.running
            ? t("btn.refreshClaimCooldownTitle", { n: Math.ceil((refreshClaim.cooldownUntil - Date.now()) / 1000) })
            : t("btn.refreshClaimTitle")}
        >
          <Ic name="refresh" size={16} />{" "}
          {refreshClaim.running
            ? t("btn.refreshClaimRunning", { done: refreshClaim.done, total: refreshClaim.total })
            : t("btn.refreshClaim")}
        </button>
      ) : null}

      <button
        className={"tog-inline" + (s.auto_claim ? " on" : "") + (autoClaimRunning ? " running" : "")}
        role="switch"
        aria-checked={s.auto_claim}
        aria-label={t("btn.autoClaim")}
        title={autoPillTitle(s)}
        onClick={() => actions.toggleAutoClaim()}
      >
        <span className={"toggle" + (s.auto_claim ? " on" : "")} aria-hidden="true">
          <span className="knob" />
        </span>
        {t("btn.autoClaim")}
      </button>

      <button className="btn-ghost has-ic" onClick={() => actions.addAccount()} title={t("btn.addAccountTitle")}>
        <Ic name="userPlus" size={16} /> {t("btn.addAccount")}
      </button>

      {s.zcode_running ? (
        <button className="btn-ghost has-ic" onClick={() => actions.askKill()} title={t("btn.killZcode")}>
          <Ic name="power" size={16} /> {t("btn.killZcode")}
        </button>
      ) : (
        <button className="btn-ghost has-ic" onClick={() => actions.launch()} disabled={!s.zcode_path_ok}>
          <Ic name="play" size={14} /> {t("btn.launchZcode")}
        </button>
      )}

      <span className="tb-spacer" />
    </section>
  );
}

function RenameRow({ a, isActive }) {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className={"row" + (isActive ? " active" : "")} data-id={a.id}>
      <span className="notch" style={{ background: notchColor(a.id) }} />
      <div className="row-main">
        <input
          ref={inputRef}
          className="rename-input"
          value={store.renamingText}
          maxLength={40}
          onChange={(e) => actions.setRenamingText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") actions.doRename(a.id);
            if (e.key === "Escape") actions.cancelRename();
          }}
          onBlur={() => actions.deferCancelRename(a.id)}
        />
        <div className="row-meta">{t("btn.renameMeta")}</div>
      </div>
      <div className="row-actions">
        <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => actions.doRename(a.id)}>
          {t("common.save")}
        </button>
        <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => actions.cancelRename()}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function AccountRow({ a, quota, plan, claimDisabled }) {
  const isActive = a.is_active;
  if (store.renaming === a.id) return <RenameRow a={a} isActive={isActive} />;

  const ident = [a.identity?.username, a.identity?.email].filter(Boolean).join(" · ");
  const exp = expireInfo(quota?.data?.plan_expire, quota?.data?.plan_starts);
  const metaBits = [];
  if (!a.has_config) metaBits.push(<span key="cfg" className="no-cfg">{t("q.noCfg")}</span>);
  if (exp) {
    metaBits.push(
      <span key="exp" className={exp.warn ? "warn-line" : ""}>
        {t("q.validUntil", { date: exp.text })}
      </span>,
    );
  }
  if (ident) {
    if (metaBits.length) metaBits.push(<span key="sep">{" · "}</span>);
    metaBits.push(<span key="ident">{ident}</span>);
  }

  const badges = tierBadges(quota?.data);

  return (
    <div className={"row" + (isActive ? " active" : "")} data-id={a.id}>
      <div className="row-top">
        <span className="notch" style={{ background: notchColor(a.id) }} />
        <div className="row-main">
          <div className="row-name">
            {a.name}
            <TierBadges pairs={badges} />
            {isActive ? <span className="tag-use">{t("btn.inUse")}</span> : null}
            {a.has_user_info === false
              ? <span className="tag-relogin" title={t("btn.reloginTitle")}>{t("btn.relogin")}</span>
              : null}
            {a.jwt_expired
              ? <span className="tag-relogin" title={t("btn.jwtExpiredTitle")}>{t("btn.jwtExpired")}</span>
              : null}
          </div>
          <div className="row-meta">{metaBits}</div>
        </div>
        <div className="row-actions">
          <button
            className={"icon-btn" + (isActive ? " on" : "")}
            title={isActive ? t("btn.current") : t("btn.switch")}
            aria-label={isActive ? t("btn.current") : t("btn.switch")}
            onClick={() => actions.askSwitch(a.id)}
            disabled={isActive}
          >
            <Ic name={isActive ? "check" : "swap"} size={16} />
          </button>
          <button className="icon-btn" title={t("btn.quota")} aria-label={t("btn.quota")} onClick={() => actions.acctQuota(a.id)}>
            <Ic name="gauge" size={16} />
          </button>
          <button
            className={"icon-btn" + (store.claimable[a.id]?.busy ? " on" : "")}
            title={t("btn.refreshClaimOne")}
            aria-label={t("btn.refreshClaimOne")}
            onClick={() => actions.refreshClaimOne(a.id)}
            disabled={claimDisabled || store.claimable[a.id]?.busy}
          >
            <Ic name="gift" size={16} />
          </button>
          <button className="icon-btn" title={t("btn.rename")} aria-label={t("btn.rename")} onClick={() => actions.rename(a.id)}>
            <Ic name="pen" size={16} />
          </button>
          <button className="icon-btn" title={t("btn.export")} aria-label={t("btn.export")} onClick={() => actions.exportOne(a.id)}>
            <Ic name="export" size={16} />
          </button>
          <button className="icon-btn danger" title={t("btn.delete")} aria-label={t("btn.delete")} onClick={() => actions.delete(a.id)}>
            <Ic name="x" size={16} />
          </button>
        </div>
      </div>
      <AccountQuotaSlot
        id={a.id}
        quota={quota}
        plan={plan}
        pending={!plan ? store.claimable[a.id]?.pending || null : null}
        claimDisabled={claimDisabled}
        onClaim={(id) => actions.claim(id)}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="glyph"><Ic name="empty" size={34} /></div>
      {t("m.emptyTitle")}
      <br />
      {t("m.emptyBody")}
    </div>
  );
}

export default function App() {
  const s = useStore();
  const listRef = useRef(null);
  // 池行跳转定位：记住要定位的账号 id，切到账号页后滚动+闪灯
  const [focusAcc, setFocusAcc] = useState(null);
  const [accQuery, setAccQuery] = useState("");
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const VIEWS = ["dashboard", "accounts", "gateway", "gatewayLogs", "referral", "settings", "about"];
  // 记住上次停留的菜单：localStorage 是 WebView2 持久存储，重启应用恢复
  const [view, setViewRaw] = useState(() => {
    const v = localStorage.getItem("zsw.view");
    return VIEWS.includes(v) ? v : "accounts";
  });
  const setView = (v) => {
    try { localStorage.setItem("zsw.view", v); } catch { /* 存储被禁时只是不记忆 */ }
    setViewRaw(v);
  };
  // 设置页首次打开后保活，避免每次切换都重跑 get_state 等 IPC 造成卡顿
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  if (view === "settings" && !settingsLoaded) setSettingsLoaded(true);
  // 定位闪灯：账号卡滚到可视区中心，闪一次边框后清除
  useEffect(() => {
    if (!focusAcc || view !== "accounts") return;
    const el = listRef.current?.querySelector(`[data-acc="${focusAcc}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("acc-flash");
    const timer = setTimeout(() => { el.classList.remove("acc-flash"); setFocusAcc(null); }, 1700);
    return () => clearTimeout(timer);
  }, [focusAcc, view]);

  useEffect(() => { boot(); }, []);

  // 滚动保活：React 只更新变化的文本节点，.list 元素不重建，
  // Chromium 原生 scroll anchoring 自动保住滚动位置。
  // 原生 JS innerHTML 时代的手动锚点补偿在此是双重叠加——
  // 额度槽塌缩（行高骤减）时会算出负偏移被浏览器钳到顶部，即「自动回顶」，故整体移除。

  if (store.bootError) {
    return <div className="loading" style={{ color: "var(--red)" }}>{t("common.loadFail", { e: store.bootError })}</div>;
  }
  if (!s.state) return <div className="loading">LOADING</div>;

  const st = s.state;
  const active = st.accounts.find((a) => a.is_active) || null;
  const unsaved = st.live_logged_in && !active;
  const claimableCount = st.accounts.filter((a) => (s.claimable[a.id]?.plans || []).length > 0).length;
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const claimDisabled = claimAllRunning || refreshClaim.running || claimActive || autoClaimRunning;

  const accQ = accQuery.trim().toLowerCase();
  const shownAccs = accQ ? st.accounts.filter((a) => a.name.toLowerCase().includes(accQ) || a.id.toLowerCase().includes(accQ)) : st.accounts;
  const accTotals = quotaTotals(st.accounts.map((a) => store.acctQuota[a.id]?.data).filter(Boolean));

  // 拖拽落位（#15）：按全量列表算新序，持久化成功后才改本地，失败回滚为后端序
  const dropTo = (targetId) => {
    const from = st.accounts.findIndex((x) => x.id === dragId);
    const to = st.accounts.findIndex((x) => x.id === targetId);
    const movedId = dragId;
    setDragId(null); setOverId(null);
    if (!movedId || from < 0 || to < 0 || from === to) return;
    const list = [...st.accounts];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    invoke("set_account_order", { ids: list.map((x) => x.id) })
      .then(() => { store.state.accounts = list; emit(); })
      .catch((e) => toast(stripErr(e), "err"));
  };

  return (
    <div className="shell">
      <SideNav view={view} setView={setView} s={st} unsaved={unsaved} />
      <div className="content">
        {view === "accounts" ? (
          <>
            <Toolbar s={st} active={active} claimableCount={claimableCount} />
            <div className="section-head">
              <h2>{t("m.accounts")}</h2>
              <span className="count">{accQ ? `${shownAccs.length}/${st.accounts.length}` : t("m.count", { count: st.accounts.length })}</span>
              {st.accounts.length ? (
                <input className="acc-search" type="search" value={accQuery} placeholder={t("m.searchPh")}
                  onChange={(e) => setAccQuery(e.target.value)} />
              ) : null}
            </div>
            {st.accounts.length ? (
              <div className="dash-sub">
                {t("d.quotaTotal")}
                {accTotals.length
                  ? accTotals.map((v) => (
                      <span key={v.label} className="dash-q">
                        {v.label} <b>{t("q.remainShort")} {fmtTokens(v.rem)}/{fmtTokens(v.tot)}</b>
                      </span>
                    ))
                  : <span className="dash-q dash-q-pending">…</span>}
              </div>
            ) : null}
            <main className="list" ref={listRef}>
              {st.accounts.length === 0 ? <EmptyState /> : shownAccs.length === 0 ? <div className="dash-empty">{t("m.searchNoMatch")}</div> : shownAccs.map((a) => (
                <div key={a.id} data-acc={a.id}
                  className={"acc-item"
                    + (dragId === a.id ? " acc-dragging" : "")
                    + (dragId && dragId !== a.id && overId === a.id ? " acc-over" : "")}
                  draggable={dragId === a.id}
                  onMouseUp={() => { if (dragId === a.id) setDragId(null); }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    try { e.dataTransfer.setData("text/plain", a.id); } catch { /* noop */ }
                  }}
                  onDragOver={(e) => { if (dragId && !accQ) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverId(a.id); } }}
                  onDrop={(e) => { if (dragId && !accQ) { e.preventDefault(); dropTo(a.id); } }}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}
                >
                  {!accQ && st.accounts.length > 1 ? (
                    <span className="acc-grip" title={t("m.dragHint")}
                      onMouseDown={() => setDragId(a.id)}>
                      <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
                        {[3, 7, 11].map((cy) => (
                          <g key={cy}>
                            <circle cx="3" cy={cy} r="1.2" /><circle cx="7" cy={cy} r="1.2" />
                          </g>
                        ))}
                      </svg>
                    </span>
                  ) : null}
                  <div className="acc-body">
                    <AccountRow
                      a={a}
                      quota={s.acctQuota[a.id]}
                      plan={s.claimable[a.id]?.plans?.[0] || null}
                      claimDisabled={claimDisabled}
                    />
                  </div>
                </div>
              ))}
            </main>
          </>
        ) : null}
        {view === "dashboard" ? (
          <div className="settings-view">
            <DashboardPage onNavigate={(v, accId) => { if (accId) setFocusAcc(accId); setView(v); }} />
          </div>
        ) : null}
        {settingsLoaded ? (
          <div className={"settings-view" + (view === "settings" ? "" : " hidden")}>
            <SettingsPage embedded initialState={st} visible={view === "settings"} />
          </div>
        ) : null}
        {view === "about" ? (
          <div className="settings-view">
            <AboutPage />
          </div>
        ) : null}
        {view === "gateway" ? (
          <div className="settings-view">
            <GatewayPage onOpenLogs={() => setView("gatewayLogs")}
              onOpenAccount={(id) => { setFocusAcc(id); setView("accounts"); }} />
          </div>
        ) : null}
        {view === "gatewayLogs" ? (
          <div className="settings-view">
            <GatewayLogsPage />
          </div>
        ) : null}
        {view === "referral" ? (
          <div className="settings-view">
            <ReferralPage />
          </div>
        ) : null}
      </div>
    </div>
  );
}
