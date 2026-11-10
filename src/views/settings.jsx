// React 版设置页：嵌入主窗口（App 侧边栏）与独立路径共用，弹窗/toast 复用 ui-react.jsx，
// 其副作用（右键与快捷键屏蔽）随导入生效
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast, openPwModal, dismissSplash } from "../components/ui-bus.js";
import { Ic } from "../components/iconsx.jsx";
import { init, t, lang, stripErr, beginLangSync, endLangSync, syncLang, patchLang } from "../lib/i18n.js";
import { currentTheme, setTheme } from "../lib/theme.js";

function Toggle({ on, label, desc, onClick }) {
  return (
    <div className="tog-row">
      <div className="tog-info">
        <div className="tog-label">{label}</div>
        <div className="tog-desc">{desc}</div>
      </div>
      <button
        className={"toggle" + (on ? " on" : "")}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onClick}
      >
        <span className="knob"></span>
      </button>
    </div>
  );
}

function LangSeg({ cur, onPick }) {
  return (
    <div className="tog-row">
      <div className="tog-info"><div className="tog-label">{t("s.langLabel")}</div></div>
      <div className="lang-seg" role="radiogroup" aria-label={t("s.langLabel")}>
        <button className={"lang-opt" + (cur === "zh" ? " on" : "")} role="radio" aria-checked={cur === "zh"} onClick={() => onPick("zh")}>{t("s.langZh")}</button>
        <button className={"lang-opt" + (cur === "en" ? " on" : "")} role="radio" aria-checked={cur === "en"} onClick={() => onPick("en")}>{t("s.langEn")}</button>
      </div>
    </div>
  );
}

function ThemeSeg({ cur, onPick }) {
  return (
    <div className="tog-row">
      <div className="tog-info"><div className="tog-label">{t("s.themeLabel")}</div></div>
      <div className="lang-seg" role="radiogroup" aria-label={t("s.themeLabel")}>
        <button className={"lang-opt" + (cur === "dark" ? " on" : "")} role="radio" aria-checked={cur === "dark"} onClick={() => onPick("dark")}>{t("s.themeDark")}</button>
        <button className={"lang-opt" + (cur === "light" ? " on" : "")} role="radio" aria-checked={cur === "light"} onClick={() => onPick("light")}>{t("s.themeLight")}</button>
      </div>
    </div>
  );
}

function CloseSeg({ cur, onPick }) {
  return (
    <div className="tog-row">
      <div className="tog-info">
        <div className="tog-label">{t("s.closeBehavior")}</div>
        <div className="tog-desc">{t("s.closeBehaviorDesc")}</div>
      </div>
      <div className="lang-seg" role="radiogroup" aria-label={t("s.closeBehavior")}>
        <button className={"lang-opt" + (cur === "min" ? " on" : "")} role="radio" aria-checked={cur === "min"} onClick={() => onPick("min")}>{t("s.closeBehaviorMin")}</button>
        <button className={"lang-opt" + (cur === "exit" ? " on" : "")} role="radio" aria-checked={cur === "exit"} onClick={() => onPick("exit")}>{t("s.closeBehaviorExit")}</button>
      </div>
    </div>
  );
}

export default function SettingsPage({ embedded = false, initialState = null, visible = true }) {
  // 主窗口已拉过同一份 get_state，直接作初始值，避免打开时白等一轮文件 IO
  const [state, setState] = useState(initialState);
  const [autostart, setAutostart] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [theme, setThemeState] = useState(currentTheme);
  // 侧边栏快捷钮与这里共用 zcs-theme 事件，任一处切换都同步
  useEffect(() => {
    const f = () => setThemeState(currentTheme());
    window.addEventListener("zcs-theme", f);
    return () => window.removeEventListener("zcs-theme", f);
  }, []);
  const pickTheme = setTheme;
  const pathElRef = useRef(null);
  // 出网代理池（应用级）：mode 三态 + 出口清单 + 用途开关。配置与运行态来自 proxy_settings_get
  const [pxForm, setPxForm] = useState({ mode: "off", single: "", proxies: "", sticky: true, rotate: true, riskBackoff: "", minScore: "", scopes: { gateway: true, claim: true, deploy: true, oauth: true } });
  const [pxStats, setPxStats] = useState([]);
  const [pxDirty, setPxDirty] = useState(false);
  const pxDirtyRef = useRef(false);
  const pxLoadedRef = useRef(false);
  const busy = useRef(false);
  // 开关读最新值用 ref 镜像；optRef 是乐观覆盖层——点击同步写入，
  // render 未提交时点击也能读到正确期望态，IPC 成功后清键
  const stateRef = useRef(state);
  stateRef.current = state;
  // autostart 是独立 useState，不在 state 里；readOpt 的兑底读不到它，这里单独镜像
  const autostartRef = useRef(autostart);
  autostartRef.current = autostart;
  const optRef = useRef({});
  const readOpt = (k) => (k in optRef.current ? optRef.current[k] : stateRef.current[k]);
  // 开关写盘走串行队列：每次点击都生效（UI 先翻、IPC 排队），不吞点击
  const toggleQueue = useRef(Promise.resolve());
  const pendingToggles = useRef(0);
  const dirtyWhilePending = useRef(false);
  // 主窗口保活本页（不卸载）；隐藏期间跳过 state-changed 的 refresh，重新可见时补拉一次
  const visibleRef = useRef(visible);
  const skippedHidden = useRef(false);
  useEffect(() => {
    visibleRef.current = visible;
    if (visible && skippedHidden.current) {
      skippedHidden.current = false;
      refresh().catch(() => {});
    }
  }, [visible]);

  const guard = async (fn) => {
    if (busy.current) { toast(t("common.busy")); return; }
    busy.current = true;
    try {
      await fn();
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      busy.current = false;
      flushDirty();
    }
  };

  // 开关等写盘期间，state-changed 的 refresh 会用盘上旧值把乐观 UI 打回去；
  // 先记账，队列排空后再拉一次真值
  const flushDirty = () => {
    if (dirtyWhilePending.current && !busy.current && pendingToggles.current === 0) {
      dirtyWhilePending.current = false;
      refresh().catch(() => {});
    }
  };

  const refresh = async () => {
    const [raw, auto] = await Promise.all([
      invoke("get_state"),
      invoke("autostart_status").catch((e) => { console.warn("autostart_status", e); return false; }),
    ]);
    const s = patchLang(raw);
    optRef.current = {}; // 盘上真值已覆盖一切乐观值
    setState(s);
    // 输入框聚焦时不覆盖：state-changed 可能在用户打字途中到来（切换/领取等后台动作）
    if (document.activeElement !== pathElRef.current) setPathInput(s.zcode_path || "");
    setAutostart(auto);
    if (s?.language) syncLang(s.language);
    // 出网代理：聚焦代理串输入框时不覆盖（与 path/auth proxy 同一防抖语义）
    try {
      const px = await invoke("proxy_settings_get");
      setPxStats(px.stats || []);
      if (!pxDirtyRef.current) {
        setPxForm({
          mode: ["off", "single", "pool"].includes(px.mode) ? px.mode : "off",
          single: px.single || "",
          proxies: (px.proxies || []).join("\n"),
          sticky: px.sticky !== false,
          rotate: px.rotate !== false,
          riskBackoff: String(px.riskBackoffSecs ?? ""),
          minScore: String(px.minScore ?? ""),
          scopes: { gateway: true, claim: true, deploy: true, oauth: true, ...(px.scopes || {}) },
        });
        pxLoadedRef.current = true;
      }
    } catch (e) { console.warn("proxy_settings_get", e); }
  };

  // 点击即翻 UI，IPC 串行入队；失败 toast 后拉盘上真值纠正 UI
  const enqueueToggle = (invoker) => {
    pendingToggles.current++;
    toggleQueue.current = toggleQueue.current
      .then(invoker)
      .catch((e) => { toast(stripErr(e), "err"); return refresh().catch(() => {}); })
      .finally(() => {
        pendingToggles.current--;
        flushDirty();
      });
  };

  useEffect(() => {
    const un = listen("state-changed", () => {
      if (busy.current || pendingToggles.current > 0) { dirtyWhilePending.current = true; return; }
      if (!visibleRef.current) { skippedHidden.current = true; return; }
      refresh().catch(() => {});
    });
    (async () => {
      try {
        await refresh();
        dismissSplash();
      } catch (e) {
        setLoadErr(String(e));
        dismissSplash();
      }
    })();
    return () => { un.then((f) => f()); };
  }, []);

  useEffect(() => {
    // 只在语言变化时需要同步标题；无依赖数组会让输入框每键重跑一次
    document.title = `Z·HUB ${t("s.title")}`;
  }, [lang()]);

  if (loadErr) {
    return <div className="loading" style={{ color: "var(--red)" }}>{t("common.loadFail", { e: stripErr(loadErr) })}</div>;
  }
  if (!state) {
    return <div className="loading">{t("common.loading")}</div>;
  }

  const s = state;

  const finishImport = async (report) => {
    if (report.added.length === 0 && report.skipped.length === 0) {
      toast(t("s.importNone"), "err", report.errors.join(t("common.listSep")) || undefined);
    } else {
      const parts = [];
      if (report.added.length) parts.push(t("s.importAdded", { count: report.added.length, names: report.added.join(t("common.listSep")) }));
      if (report.skipped.length) parts.push(t("s.importSkipped", { count: report.skipped.length }));
      if (report.errors.length) parts.push(t("s.importFailed", { count: report.errors.length }));
      toast(parts[0], report.errors.length ? "err" : "ok", parts.slice(1).join(t("common.listSep")));
    }
    await refresh();
  };

  const actions = {
    setLang: (l) => {
      if (l === lang()) return;
      // 先翻 UI 再异步落盘：不进 guard 队列，set_language 抢 store_guard 的等待不挡界面
      setState((v) => ({ ...v, language: l }));
      beginLangSync(l);
      init(l);
      invoke("set_language", { lang: l })
        .finally(endLangSync)
        .catch(async () => {
          // 落盘失败：拉盘上真值纠正 UI（走 syncLang/patchLang，尊重在途闸）
          const s = patchLang(await invoke("get_state"));
          optRef.current = {};
          setState(s);
          if (s?.language) syncLang(s.language);
        });
    },

    toggleAutostart: () => {
      const next = !("autostart" in optRef.current ? optRef.current.autostart : autostartRef.current);
      optRef.current.autostart = next;
      setAutostart(next);
      enqueueToggle(async () => {
        const v = await invoke("autostart_set", { enable: next });
        setAutostart(v);
        delete optRef.current.autostart;
        toast(v ? t("s.autostartOnToast") : t("s.autostartOffToast"));
      });
    },

    toggleBehavior: (key) => {
      const k = key === "launch" ? "launch_after_switch" : key === "tray" ? "close_to_tray" : "hot_switch";
      const next = !readOpt(k);
      optRef.current[k] = next;
      setState((v) => ({ ...v, [k]: next }));
      enqueueToggle(async () => {
        await invoke("set_behavior", {
          launchAfterSwitch: key === "launch" ? next : null,
          closeToTray: key === "tray" ? next : null,
          hotSwitch: key === "hot" ? next : null,
        });
        delete optRef.current[k];
      });
    },

    setCloseBehavior: (mode) => {
      const k = "close_to_tray";
      const next = mode === "min";
      if (readOpt(k) === next) return;
      optRef.current[k] = next;
      setState((v) => ({ ...v, [k]: next }));
      enqueueToggle(async () => {
        await invoke("set_behavior", {
          launchAfterSwitch: null,
          closeToTray: next,
          hotSwitch: null,
        });
        delete optRef.current[k];
      });
    },

    // 出网代理池：保存即整池重建（网关与账号管理同时生效，无需重启网关）
    pxSet: (patch) => setPxForm((v) => ({ ...v, ...patch })),
    pxMarkDirty: () => { pxDirtyRef.current = true; setPxDirty(true); },
    pxSave: () => guard(async () => {
      const f = pxForm;
      await invoke("proxy_settings_save", {
        mode: ["off", "single", "pool"].includes(f.mode) ? f.mode : "off",
        single: f.single.trim(),
        proxies: f.proxies.split("\n").map((x) => x.trim()).filter(Boolean),
        sticky: f.sticky,
        rotate: f.rotate,
        riskBackoffSecs: f.riskBackoff.trim() !== "" && Number.isFinite(parseInt(f.riskBackoff.trim(), 10)) ? Math.max(0, parseInt(f.riskBackoff.trim(), 10)) : null,
        minScore: f.minScore.trim() !== "" && Number.isFinite(parseInt(f.minScore.trim(), 10)) ? parseInt(f.minScore.trim(), 10) : null,
        scopes: f.scopes,
      });
      pxDirtyRef.current = false;
      setPxDirty(false);
      toast(t("s.pxSaved"));
      await refresh();
    }),

    exportAll: () => guard(async () => {
      const p = await invoke("export_all_pick_path");
      if (!p.picked) { toast(t("m.exportCanceled")); return; }
      openPwModal({ mode: "exportAll", path: p.path, count: p.count, onDone: () => refresh() });
    }),

    importFiles: () => guard(async () => {
      const p = await invoke("import_pick_files");
      if (!p.picked) return;
      const sealed = p.sealed || [];
      const preErrors = p.errors || [];
      if (sealed.length) {
        openPwModal({ mode: "import", files: sealed, preErrors, onDone: finishImport });
        return;
      }
      finishImport({ added: [], skipped: [], errors: preErrors });
    }),

    browsePath: () => guard(async () => {
      const r = await invoke("pick_zcode_path");
      if (r.picked) {
        await invoke("set_zcode_path", { path: r.path });
        toast(t("s.pathUpdated"));
        await refresh();
      }
    }),

    savePath: () => guard(async () => {
      const v = pathInput.trim();
      await invoke("set_zcode_path", { path: v });
      toast(v ? t("s.pathUpdated") : t("s.pathAuto"));
      await refresh();
    }),


  };

  return (
    <>
      {!embedded && (
        <header className="topbar">
          <div className="wordmark">Z·HUB <span className="ver">/ {t("s.title")}</span></div>
        </header>
      )}
      <section className="settings open">
        <div className="set-card">
          <label>{t("s.generalLabel")}</label>
          <LangSeg cur={s.language || "zh"} onPick={actions.setLang} />
          <ThemeSeg cur={theme} onPick={pickTheme} />
        </div>
        <div className="set-card">
          <label>{t("s.behaviorLabel")}</label>
          <Toggle on={autostart} label={t("s.autostart")} desc={t("s.autostartDesc")} onClick={actions.toggleAutostart} />
          <Toggle on={s.launch_after_switch} label={t("s.launchAfter")} desc={t("s.launchAfterDesc")} onClick={() => actions.toggleBehavior("launch")} />
          <CloseSeg cur={s.close_to_tray ? "min" : "exit"} onPick={actions.setCloseBehavior} />
          <Toggle on={s.hot_switch} label={t("s.hotSwitch")} desc={t("s.hotSwitchDesc")} onClick={() => actions.toggleBehavior("hot")} />
        </div>
        <div className="set-card">
          <label>{t("s.pxLabel")}</label>
          <div className="px-sec">
            <div className="px-sec-title">{t("s.pxSecEgress")}</div>
            <div className="tog-row">
              <div className="tog-info"><div className="tog-label">{t("s.pxMode")}</div></div>
              <div className="lang-seg" role="radiogroup" aria-label={t("s.pxMode")}>
                {["off", "single", "pool"].map((m) => (
                  <button key={m} className={"lang-opt" + (pxForm.mode === m ? " on" : "")} role="radio" aria-checked={pxForm.mode === m}
                    title={t(m === "off" ? "s.pxModeOffDesc" : m === "single" ? "s.pxModeSingleDesc" : "s.pxModePoolDesc")}
                    onClick={() => { actions.pxMarkDirty(); actions.pxSet({ mode: m }); }}>{t(m === "off" ? "s.pxModeOff" : m === "single" ? "s.pxModeSingle" : "s.pxModePool")}</button>
                ))}
              </div>
            </div>
            <div className="px-sec-note">{t(pxForm.mode === "off" ? "s.pxModeOffDesc" : pxForm.mode === "single" ? "s.pxModeSingleDesc" : "s.pxModePoolDesc")}</div>
            {pxForm.mode === "single" ? (
              <label className="px-field">
                <span>{t("s.pxFSingle")}</span>
                <input className="zcode-path" type="text" value={pxForm.single}
                  placeholder={t("s.pxProxiesPh").split("\n")[0]}
                  onChange={(e) => { actions.pxMarkDirty(); actions.pxSet({ single: e.target.value }); }} />
              </label>
            ) : null}
            {pxForm.mode === "pool" ? (
              <label className="px-field">
                <span>{t("s.pxFProxies")}</span>
                <textarea className="zcode-path" rows={4} value={pxForm.proxies}
                  placeholder={t("s.pxProxiesPh")}
                  onChange={(e) => { actions.pxMarkDirty(); actions.pxSet({ proxies: e.target.value }); }} />
                <div className="hint">{t("s.pxFProxiesHint")}</div>
              </label>
            ) : null}
          </div>
          {pxForm.mode !== "off" ? (
            <div className="px-sec">
              <div className="px-sec-title">{t("s.pxSecPolicy")}</div>
              <div className="px-fields">
                <label className="px-field">
                  <span>{t("s.pxFRiskBackoff")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={pxForm.riskBackoff}
                    placeholder="45" onChange={(e) => { actions.pxMarkDirty(); actions.pxSet({ riskBackoff: e.target.value }); }} />
                  <div className="hint">{t("s.pxFRiskBackoffHint")}</div>
                </label>
                <label className="px-field">
                  <span>{t("s.pxFMinScore")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={pxForm.minScore}
                    placeholder="-2" onChange={(e) => { actions.pxMarkDirty(); actions.pxSet({ minScore: e.target.value }); }} />
                  <div className="hint">{t("s.pxFMinScoreHint")}</div>
                </label>
              </div>
              <Toggle on={pxForm.sticky !== false} label={t("s.pxFSticky")} desc={t("s.pxFStickyHint")} onClick={() => { actions.pxMarkDirty(); actions.pxSet({ sticky: pxForm.sticky === false }); }} />
              <Toggle on={pxForm.rotate !== false} label={t("s.pxFRotate")} desc={t("s.pxFRotateHint")} onClick={() => { actions.pxMarkDirty(); actions.pxSet({ rotate: pxForm.rotate === false }); }} />
            </div>
          ) : null}
          {pxForm.mode !== "off" ? (
            <div className="px-sec">
              <div className="px-sec-title">{t("s.pxSecScopes")}</div>
              <div className="px-scopes">
                {["gateway", "claim", "deploy", "oauth"].map((sc) => (
                  <Toggle key={sc} on={pxForm.scopes[sc] !== false}
                    label={t(`s.pxScope_${sc}`)} desc={t(`s.pxScope_${sc}Desc`)}
                    onClick={() => { actions.pxMarkDirty(); actions.pxSet({ scopes: { ...pxForm.scopes, [sc]: !(pxForm.scopes[sc] ?? true) } }); }} />
                ))}
              </div>
            </div>
          ) : null}
          <div className="px-save-row">
            <button className="btn-ghost" onClick={actions.pxSave}>{t("s.pxSave")}</button>
            {pxDirty ? <span className="px-dirty">{t("s.pxDirty")}</span> : <span className="px-saved">{t("s.pxSavedState")}</span>}
          </div>
          {pxStats.length > 0 ? (
            <div className="px-stats">
              <span className="px-stat">{t("s.pxStatTotal", { n: pxStats.length })}</span>
              <span className={"px-stat" + (pxStats.filter((p) => p.cooling).length > 0 ? " warn" : "")}>{t("s.pxStatCooling", { n: pxStats.filter((p) => p.cooling).length })}</span>
            </div>
          ) : null}
          <div className="hint">{t("s.pxHint")}</div>
        </div>
        <div className="set-card">
          <label>{t("s.libLabel")}</label>
          <div className="lib-row">
            <button className="btn-ghost has-ic" onClick={actions.importFiles}><Ic name="import" size={14} /> {t("s.importBtn")}</button>
            <button className="btn-ghost has-ic" onClick={actions.exportAll} disabled={!s.accounts.length}><Ic name="exportAll" size={14} /> {t("s.exportAllBtn")}</button>
          </div>
        </div>
        <div className="set-card">
          <label>{t("s.pathLabel")}</label>
          <div className="path-line">
            <input ref={pathElRef} className="zcode-path" type="text" value={pathInput} placeholder="C:\\Program Files\\ZCode\\ZCode.exe"
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") actions.savePath(); }} />
            <button className="btn-ghost" onClick={actions.browsePath}>{t("s.browse")}</button>
            <button className="btn-ghost" onClick={actions.savePath}>{t("common.save")}</button>
          </div>
          <div className="hint">{t("s.hint")}</div>
        </div>
      </section>
    </>
  );
}
