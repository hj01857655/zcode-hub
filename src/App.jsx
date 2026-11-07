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
import { GlassPane } from "./components/GlassPane.jsx";
import { AccountQuotaSlot, TierBadges } from "./components/QuotaView.jsx";
import SettingsPage from "./views/settings.jsx";
import AboutPage from "./views/about.jsx";
import GatewayPage from "./views/gateway.jsx";
import GatewayLogsPage from "./views/gateway-logs.jsx";
import SysLogPage from "./views/syslog.jsx";
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
  // 折叠态记忆：localStorage（WebView2 持久存储）与 zsw.view 同一套前缀，重启恢复
  const [folded, setFolded] = useState(() => localStorage.getItem("zsw.sideFold") === "1");
  const toggleFold = () => setFolded((f) => {
    const next = !f;
    try { localStorage.setItem("zsw.sideFold", next ? "1" : "0"); } catch { /* 存储被禁时只是不记忆 */ }
    return next;
  });
  // 导航项清单：视图 / 图标 / 文案键；折叠态只剩图标，全名进悬停提示
  // 三段语义分组：运营（仪表盘/账号/邀请）、网关运维（网关/请求日志/系统日志）、辅助（设置/关于），
  // 组间 "sep" 渲染为 hairline 分隔
  const NAV = [
    ["dashboard", "gauge", "d.menu"],
    ["accounts", "list", "m.accounts"],
    ["referral", "link", "r.menu"],
    ["sep", "ops-gw"],
    ["gateway", "swap", "x.menuLabel"],
    ["gatewayLogs", "clock", "xl.menuLabel"],
    ["syslog", "doc", "sl.menuLabel"],
    ["sep", "gw-misc"],
    ["settings", "sliders", "common.settings"],
    ["about", "info", "a.menuLabel"],
  ];
  const foldTip = t(folded ? "m.sideExpand" : "m.sideFold");
  return (
    <GlassPane id="sidebar" source="desktop" className={"sidenav" + (folded ? " folded" : "")}>
      <div className="side-logo">
        <span className="side-brand">
          Z·HUB{store.appVer ? <span className="ver" title={`v${store.appVer}`}>v{store.appVer.split(".").slice(0, 3).join(".")}</span> : null}
        </span>
        <button className="side-fold" title={foldTip} aria-label={foldTip} onClick={toggleFold}>
          <Ic name="panel" size={15} />
        </button>
      </div>
      {NAV.map((n) =>
        n[0] === "sep" ? (
          <div key={n[1]} className="side-sep" aria-hidden="true" />
        ) : (
          <button
            key={n[0]}
            className={"side-item" + (view === n[0] ? " on" : "")}
            onClick={() => setView(n[0])}
            title={folded ? t(n[2]) : undefined}
          >
            <Ic name={n[1]} size={16} /> <span className="side-label">{t(n[2])}</span>
          </button>
        ),
      )}
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
    </GlassPane>
  );
}

function Toolbar({ s, active, claimableCount, unsaved }) {
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const cooling = Date.now() < refreshClaim.cooldownUntil;
  return (
    <section className="toolbar">
      {/* 防丢号直入口：ZCode 在跑且登录未入库时，保存动作不再藏在添加弹窗里 */}
      {unsaved ? (
        <button
          className="btn-ghost has-ic save-login-cta"
          onClick={() => actions.capture()}
          title={t("btn.captureTitle")}
        >
          <Ic name="check" size={16} /> {t("btn.saveLogin")}
        </button>
      ) : null}
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

      <button className="btn-primary has-ic" onClick={() => actions.addAccount()} title={t("btn.addAccountTitle")}>
        <Ic name="userPlus" size={16} /> {t("btn.addAccount")}
      </button>

      <span className="tb-sep" aria-hidden="true" />
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
    // 分色与仪表盘对齐：≤5 天红（soon）、≤7 天黄（warn）；短窗口批次（≤48h）不算告警
    metaBits.push(
      <span key="exp" className={exp.soon ? "soon-line" : exp.warn ? "warn-line" : ""}>
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
            className={"icon-btn" + (isActive ? " on" : "") + (store.switchingId === a.id ? " switching" : "")}
            title={store.switchingId === a.id ? t("btn.switching") : isActive ? t("btn.current") : t("btn.switch")}
            aria-label={store.switchingId === a.id ? t("btn.switching") : isActive ? t("btn.current") : t("btn.switch")}
            onClick={() => actions.askSwitch(a.id)}
            disabled={isActive || store.switching}
          >
            <Ic name={store.switchingId === a.id ? "refresh" : isActive ? "check" : "swap"} size={16} />
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
        history={!plan && !store.claimable[a.id]?.pending ? store.claimHistory[a.id]?.history || null : null}
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
  const searchRef = useRef(null);
  // 状态筛选 chips：all / claimable / pending / relogin（与文本搜索叠加，切页不残留）
  const [accFilter, setAccFilter] = useState("all");
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const VIEWS = ["dashboard", "accounts", "gateway", "gatewayLogs", "syslog", "referral", "settings", "about"];
  // 记住上次停留的菜单：localStorage 是 WebView2 持久存储，重启应用恢复
  const [view, setViewRaw] = useState(() => {
    const v = localStorage.getItem("zsw.view");
    return VIEWS.includes(v) ? v : "accounts";
  });
  const setView = (v) => {
    try { localStorage.setItem("zsw.view", v); } catch { /* 存储被禁时只是不记忆 */ }
    // 离开账号页清搜索词与筛选：残留的过滤会让下次回页出现「3/12」式的困惑计数
    if (v !== "accounts") { setAccQuery(""); setAccFilter("all"); }
    setViewRaw(v);
  };
  // 设置页首次打开后保活，避免每次切换都重跑 get_state 等 IPC 造成卡顿
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  if (view === "settings" && !settingsLoaded) setSettingsLoaded(true);
  // 定位闪灯：账号卡滚到可视区中心，闪一次边框后清除
  useEffect(() => {
    if (!focusAcc || view !== "accounts") return;
    // 跳转目标必须可见：搜索词/筛选可能把目标行过滤掉导致 scrollIntoView 静默失效
    if (accQuery) setAccQuery("");
    if (accFilter !== "all") setAccFilter("all");
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
  if (!s.state) return <div className="loading">{t("common.loading")}</div>;

  const st = s.state;
  const active = st.accounts.find((a) => a.is_active) || null;
  const unsaved = st.live_logged_in && !active;
  const claimableCount = st.accounts.filter((a) => (s.claimable[a.id]?.plans || []).length > 0).length;
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const claimDisabled = claimAllRunning || refreshClaim.running || claimActive || autoClaimRunning;

  const accQ = accQuery.trim().toLowerCase();
  // 状态筛选谓词（与文本搜索叠加）：可领 / 待生效 / 需重登（含 JWT 过期）
  const ACC_FILTERS = {
    all: null,
    claimable: (a) => (s.claimable[a.id]?.plans || []).length > 0,
    pending: (a) => !!s.claimable[a.id]?.pending,
    relogin: (a) => a.has_user_info === false || a.jwt_expired,
  };
  const shownAccs = st.accounts.filter((a) => {
    if (accQ && !(a.name.toLowerCase().includes(accQ) || a.id.toLowerCase().includes(accQ))) return false;
    const pred = ACC_FILTERS[accFilter] || ACC_FILTERS.all;
    return pred ? pred(a) : true;
  });
  // 各档计数（全量口径，不随当前筛选变——计数是导航辅助，不是结果统计）
  const filterCounts = {
    all: st.accounts.length,
    claimable: claimableCount,
    pending: st.accounts.filter((a) => !!s.claimable[a.id]?.pending).length,
    relogin: st.accounts.filter((a) => a.has_user_info === false || a.jwt_expired).length,
  };
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
            <Toolbar s={st} active={active} claimableCount={claimableCount} unsaved={unsaved} />
            <div className="section-head">
              <h2>{t("m.accounts")}</h2>
              <span className="count">{(accQ || accFilter !== "all") ? `${shownAccs.length}/${st.accounts.length}` : t("m.count", { count: st.accounts.length })}</span>
              {st.accounts.length ? (
                <input
                  ref={searchRef}
                  className="acc-search"
                  type="search"
                  value={accQuery}
                  placeholder={t("m.searchPh")}
                  onChange={(e) => setAccQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape 清空并还焦点：搜索是临时态，键盘一条路走完
                    if (e.key === "Escape" && accQuery) {
                      e.stopPropagation();
                      setAccQuery("");
                      searchRef.current?.focus();
                    }
                  }}
                />
              ) : null}
            </div>
            {/* 状态筛选 chips：与文本搜索叠加；各档计数为全量口径（导航辅助） */}
            {st.accounts.length ? (
              <div className="acc-filters">
                {[["all", t("f.all")], ["claimable", t("f.claimable")], ["pending", t("f.pending")], ["relogin", t("f.relogin")]].map(([key, label]) => (
                  <button
                    key={key}
                    className={"acc-chip" + (accFilter === key ? " on" : "")}
                    onClick={() => setAccFilter(accFilter === key ? "all" : key)}
                  >
                    {label}{filterCounts[key] ? ` ${filterCounts[key]}` : ""}
                  </button>
                ))}
              </div>
            ) : null}
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
        {view === "syslog" ? (
          <div className="settings-view">
            <SysLogPage />
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
