// App.jsx — 渲染层根组件。class 名与 DOM 层级保持与原 innerHTML 模板一致，CSS 无需改动。
import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Ic } from "./components/iconsx.jsx";
import { init, t, beginLangSync, endLangSync } from "./lib/i18n.js";
import { currentTheme, setTheme } from "./lib/theme.js";
import {
  store, subscribe, getVersion, boot, emit,
} from "./lib/store.js";
import { GlassPane } from "./components/GlassPane.jsx";
import AccountsPage from "./views/accounts.jsx";
import SettingsPage from "./views/settings.jsx";
import AboutPage from "./views/about.jsx";
import GatewayPage from "./views/gateway.jsx";
import GatewayLogsPage from "./views/gateway-logs.jsx";
import SysLogPage from "./views/syslog.jsx";
import ReferralPage from "./views/referral.jsx";
import DashboardPage from "./views/dashboard.jsx";

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

export default function App() {
  const s = useStore();
  // 池行跳转定位：网关页/仪表盘 onOpenAccount 记下账号 id，切到账号页后由页内滚动+闪灯
  // （状态留在 App 层：账号页切走即卸载，页内 state 存不住定位目标）
  const [focusAcc, setFocusAcc] = useState(null);
  const VIEWS = ["dashboard", "accounts", "gateway", "gatewayLogs", "syslog", "referral", "settings", "about"];
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

  useEffect(() => { boot(); }, []);

  // 滚动保活：React 只更新变化的文本节点，.list 元素不重建，
  // Chromium 原生 scroll anchoring 自动保住滚动位置。
  // 原生 JS innerHTML 时代的手动锚点补偿在此是双重叠加——
  // 额度槽塌缩（行高骤减）时会算出负偏移被浏览器钳到顶部，即「自动回顶」，故整体移除。

  if (store.bootError) {
    return <div className="loading err">{t("common.loadFail", { e: store.bootError })}</div>;
  }
  if (!s.state) return <div className="loading">{t("common.loading")}</div>;

  const st = s.state;
  const active = st.accounts.find((a) => a.is_active) || null;
  const unsaved = st.live_logged_in && !active;

  return (
    <div className="shell">
      <SideNav view={view} setView={setView} s={st} unsaved={unsaved} />
      <div className="content">
        {view === "accounts" ? (
          <AccountsPage focusAcc={focusAcc} onFocusDone={() => setFocusAcc(null)} />
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
