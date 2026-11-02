// React 版 UI 服务层：同签名替代 lib/ui.js（原生 DOM 拼接层）。
// toast / 三个模态框走模块内事件总线 + createRoot 挂载的宿主组件；
// 右键与快捷键屏蔽副作用随本模块导入生效（dev 模式放开 F12/控制台）。
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Ic } from "./iconsx.jsx";
import { t, has, errCode, stripErr } from "../lib/i18n.js";

document.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("keydown", (e) => {
  if (import.meta.env.DEV) return;
  if (e.key === "F12") e.preventDefault();
  if (e.ctrlKey && e.shiftKey && ["I", "i", "J", "j", "C", "c"].includes(e.key)) e.preventDefault();
  if (e.ctrlKey && ["u", "s"].includes(e.key.toLowerCase())) e.preventDefault();
});

import { ui, emit, subscribe, getVersion, toast } from "./ui-bus.js";

function useUi() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return ui;
}

function Toast({ x }) {
  // 长 detail（多行/超长，如完整响应体）默认收起，点击整条切换展开
  const [open, setOpen] = useState(false);
  const long = !!x.detail && (x.detail.includes("\n") || x.detail.length > 90);
  const shown = long && !open ? x.detail.split("\n")[0].slice(0, 90) + "…" : x.detail;
  return (
    <div
      className={"toast " + x.kind + (long ? " expandable" : "") + (open ? " open" : "")}
      onClick={long ? () => setOpen(!open) : undefined}
      title={long ? t(open ? "m.toastCollapse" : "m.toastExpand") : undefined}
    >
      <span className="t-ic"><Ic name={x.kind === "ok" ? "check" : "alert"} size={16} /></span>
      <span className="t-body">
        {x.msg}
        {x.detail
          ? <span className="detail">
              {shown}
              {long ? <span className="detail-caret">{open ? " ▲" : " ▼"}</span> : ""}
            </span>
          : ""}
      </span>
    </div>
  );
}

function ToastHost() {
  const u = useUi();
  return (
    <div className="toast-zone">
      {u.toasts.map((x) => <Toast key={x.id} x={x} />)}
    </div>
  );
}

function ConfirmModal() {
  const u = useUi();
  const m = u.confirm;
  const yesRef = useRef(null);
  const noRef = useRef(null);
  const close = () => { ui.confirm = ui.confirmQ?.shift() || null; emit(); };

  useEffect(() => {
    if (!m) return;
    (m.focusNo || m.kind === "danger" ? noRef.current : yesRef.current)?.focus();
    const key = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && e.target === document.body && !yesRef.current?.disabled) yesRef.current?.click();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [m]);

  if (!m) return null;
  const kind = m.kind || "plain";
  return (
    <div className="cm-mask" onClick={close}>
      <div
        className="cm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={m.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`cm-strip ${kind}`}></div>
        <div className="cm-head">
          <span className={`cm-ic ${kind}`}><Ic name={m.icon || "alert"} size={21} /></span>
          <div className="cm-title">{m.title}</div>
        </div>
        {/* desc 允许携带富文本（与原 ui.js 行为一致） */}
        {m.desc ? <div className="cm-desc" dangerouslySetInnerHTML={{ __html: m.desc }} /> : null}
        <div className="cm-actions">
          <button className="btn-ghost cm-no" ref={noRef} onClick={close}>{m.noLabel || t("common.cancel")}</button>
          <button
            className={`cm-yes ${kind}`}
            ref={yesRef}
            onClick={async (e) => {
              e.currentTarget.disabled = true;
              if (noRef.current) noRef.current.disabled = true;
              try { await m.onYes?.(); } finally { close(); }
            }}
          >
            {m.yesLabel || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PwModal() {
  const u = useUi();
  const m = u.pw;
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const input1Ref = useRef(null);
  const close = () => { ui.pw = null; emit(); };

  useEffect(() => {
    if (!m) return;
    setPw1(""); setPw2(""); setErr(""); setBusy(false);
    input1Ref.current?.focus();
    // Esc 全局兜底：焦点不在输入框（Tab 到按钮/面板）时也能关闭
    const onEsc = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [m]);

  if (!m) return null;
  const isExport = m.mode === "export" || m.mode === "exportAll";
  const title = m.mode === "export" ? t("pw.exportTitle", { name: m.name })
    : m.mode === "exportAll" ? t("pw.exportAllTitle", { count: m.count })
    : t("pw.importTitle", { count: m.files.length });
  const sub = isExport
    ? t("pw.exportSub", { path: m.path })
    : t("pw.importSub", { files: m.files.map(([n]) => n).join(t("common.listSep")) });

  async function confirm() {
    if (pw1.length < 6) return setErr(t("pw.errMinLen"));
    if (isExport && pw1 !== pw2) return setErr(t("pw.errMismatch"));
    setBusy(true);
    try {
      if (m.mode === "export") {
        const r = await invoke("export_finalize", { path: m.path, id: m.id, password: pw1 });
        toast(t("pw.exportedToast", { path: r.path }), "ok", t("pw.exportedToastDetail"));
        m.onDone?.(r);
      } else if (m.mode === "exportAll") {
        const r = await invoke("export_all_finalize", { path: m.path, password: pw1 });
        toast(t("pw.exportedAllToast", { count: r.count }), "ok", r.path);
        m.onDone?.(r);
      } else {
        let report = await invoke("import_sealed", { files: m.files, password: pw1 });
        if (m.preErrors?.length) {
          report.errors = [...m.preErrors, ...(report.errors || [])];
        }
        const wrongPw = (report.errors || []).some((e) => errCode(e) === "wrong_password" || String(e).includes("密码错误"));
        if (wrongPw) { setErr(t("pw.errWrong")); setBusy(false); return; }
        m.onDone?.(report);
      }
      close();
    } catch (e) {
      setErr(stripErr(e));
      setBusy(false);
    }
  }

  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && !busy) confirm();
  };

  return (
    <div className="pw-mask" onClick={close}>
      <div className="pw-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pw-title">{title}</div>
        <div className="pw-sub">{sub}</div>
        <input
          ref={input1Ref}
          className="pw-input" type="password" autoComplete="off"
          placeholder={isExport ? t("pw.setPw") : t("pw.pw")}
          value={pw1} onChange={(e) => setPw1(e.target.value)} onKeyDown={onKey}
        />
        {isExport ? (
          <input
            className="pw-input" type="password" autoComplete="off"
            placeholder={t("pw.pwAgain")}
            value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={onKey}
          />
        ) : null}
        <div className="pw-err">{err}</div>
        <div className="pw-actions">
          <button className="btn-ghost pw-cancel" onClick={close}>{t("common.cancel")}</button>
          <button className="btn-primary pw-go has-ic" disabled={busy} onClick={confirm}>
            <Ic name={isExport ? "lock" : "lockOpen"} size={14} />{" "}
            {isExport ? t("pw.encryptExport") : t("pw.decryptImport")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderModal() {
  const u = useUi();
  const m = u.provider;
  const [tab, setTab] = useState("browser");
  const close = () => { ui.provider = null; emit(); };

  useEffect(() => {
    if (!m) return;
    setTab("browser");
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [m]);

  if (!m) return null;
  const displayOf = (p) => (has(`prov.${p.id}`) ? t(`prov.${p.id}`) : p.display);
  return (
    <div className="pv-mask" onClick={close}>
      <div className="pv-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pv-title">{t("prov.title")}</div>
        <div className="bl-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "browser"} className={"bl-tab" + (tab === "browser" ? " on" : "")}
            onClick={() => setTab("browser")}>{t("m.blTabBrowser")}</button>
          <button role="tab" aria-selected={tab === "embedded"} className={"bl-tab" + (tab === "embedded" ? " on" : "")}
            onClick={() => setTab("embedded")}>{t("m.blTabEmbedded")}</button>
        </div>
        {/* locale 文案含 <br>/<b>，与 cm-desc 同款处理，避免标签原样显示 */}
        <div className="pv-sub" dangerouslySetInnerHTML={{ __html: t(tab === "browser" ? "m.blTabBrowserSub" : "prov.sub") }} />
        <div className="pv-list">
          {(m.providers || []).map((p) => (
            <button
              key={p.id}
              className="pv-item"
              onClick={() => { close(); m.onPick?.(p.id, tab === "browser"); }}
            >
              <span className="pv-name">{displayOf(p)}</span>
              <span className="pv-arrow">→</span>
            </button>
          ))}
        </div>
        {m.onSaveLogin ? (
          <button
            className="pv-item pv-save"
            disabled={!m.canSaveLogin}
            title={m.saveLoginTitle || ""}
            onClick={() => { if (!m.canSaveLogin) return; close(); m.onSaveLogin?.(); }}
          >
            <span className="pv-name">{t("btn.saveLogin")}</span>
            <span className="pv-arrow">→</span>
          </button>
        ) : null}
        <div className="pv-actions">
          <button className="btn-ghost pv-cancel" onClick={close}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

// 系统浏览器登录等待窗（#40）：oauth_begin browser=true 打开外链后弹出。
// 入库靠后端 poll 通道，本窗只做辅助（复制链接/重开浏览器/回退内嵌窗/取消）。
function BrowserLoginModal() {
  const u = useUi();
  const m = u.browserLogin;
  const [copied, setCopied] = useState(false);
  const close = () => { ui.browserLogin = null; emit(); };

  useEffect(() => {
    if (!m) return;
    const onKey = (e) => { if (e.key === "Escape") { invoke("oauth_cancel").catch(() => {}); close(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [m]);

  if (!m) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(m.url || ""); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = m.url || ""; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* noop */ }
      ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  const fallback = async () => {
    close();
    try {
      await invoke("oauth_begin", { provider: m.provider, browser: false });
      toast(t("m.loginWindowOpened"), "ok", t("m.loginWindowDetail"));
    } catch (e) { toast(stripErr(e), "err"); }
  };
  const cancel = () => { invoke("oauth_cancel").catch(() => {}); close(); };
  return (
    <div className="pv-mask" onClick={cancel}>
      <div className="pv-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pv-title">{t("m.browserLoginTitle")}</div>
        <div className="pv-sub">{t("m.browserLoginSub")}</div>
        <div className="bl-wait"><span className="bl-spin" aria-hidden="true" /> {t("m.browserLoginWaiting")}</div>
        <textarea className="bl-url" readOnly value={m.url || ""}
          onFocus={(e) => e.target.select()} onClick={(e) => e.target.select()} />
        <div className="pv-actions bl-actions">
          <button className="btn-ghost" onClick={copy}>{copied ? t("m.browserLoginCopied") : t("m.browserLoginCopy")}</button>
          <button className="btn-ghost" onClick={() => invoke("open_external", { url: m.url || "" }).catch((e) => toast(stripErr(e), "err"))}>{t("m.browserLoginReopen")}</button>
          <button className="btn-ghost" onClick={fallback}>{t("m.browserLoginFallback")}</button>
          <button className="btn-ghost pv-cancel" onClick={cancel}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

// 首个 pv-item 自动聚焦（挂载后 DOM 由 React 接管，用事件委托找不到 ref，这里直接查询）
function ProviderFocus() {
  const u = useUi();
  useEffect(() => {
    if (u.provider) document.querySelector(".pv-item")?.focus();
  }, [u.provider]);
  return null;
}

const host = document.createElement("div");
document.body.appendChild(host);
createRoot(host).render(
  <>
    <ToastHost />
    <ConfirmModal />
    <PwModal />
    <ProviderModal />
    <BrowserLoginModal />
    <ProviderFocus />
  </>,
);
