// React 版 Gateway 页：反代服务控制面板（M1 接线 gateway_start/stop/status）
// 布局与设置页同构（靠左表单流 .settings），状态区置顶。
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, stripErr } from "../lib/i18n.js";
import { toast } from "../components/ui-bus.js";
import { Ic } from "../components/iconsx.jsx";
import { GatewayTestModal } from "../components/gateway-test.jsx";
import { useVisiblePolling } from "../lib/pageVisible.js";

// 端点输入即配置：host 固定本机，端口从 URL 解析（省略端口 = 默认 8081）；解析失败返回 null
const parseEndpoint = (s) => {
  try {
    const u = new URL(s.trim());
    if ((u.protocol !== "http:" && u.protocol !== "https:")
      || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) return null;
    const p = u.port ? parseInt(u.port, 10) : 8081;
    return (Number.isFinite(p) && p > 0 && p <= 65535) ? p : null;
  } catch { return null; }
};

export default function GatewayPage({ onOpenLogs, onOpenAccount }) {
  const [status, setStatus] = useState(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  // 调优项（端口/密钥/超时/重试/退避/CORS/体积上限/日志/sticky）收进「配置」对话框，页面只留端点概览
  const [tuneOpen, setTuneOpen] = useState(false);
  // 测试请求弹窗：选模型、填消息、发真请求、看结果（自包含组件 gateway-test.jsx）；历史留痕可回看
  const [testOpen, setTestOpen] = useState(false);
  const [accProto, setAccProto] = useState("chat");
  const [copiedEx, setCopiedEx] = useState(false);
  const [connectInput, setConnectInput] = useState("");
  const [retriesInput, setRetriesInput] = useState("");
  const [backoffInput, setBackoffInput] = useState("");
  const [corsInput, setCorsInput] = useState("");
  const [bodyLimitInput, setBodyLimitInput] = useState("");
  const [logDiskInput, setLogDiskInput] = useState(true);
  const [logMaxInput, setLogMaxInput] = useState("");
  const [stickyInput, setStickyInput] = useState(true);
  const [failsInput, setFailsInput] = useState("");
  const [keepaliveInput, setKeepaliveInput] = useState("");
  const [timeoutInput, setTimeoutInput] = useState("");
  // 用户是否动过 key/端点输入框：没动过就跟随盘上真值（启动/换号后 key 会变），动过则尊重输入
  const keyTouched = useRef(false);
  const epTouched = useRef(false);
  // 配置对话框开着时不让轮询把开关草稿刷回盘上值
  const tuneOpenRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  // key 显隐：默认打码（••••），眼睛切换
  const [showKey, setShowKey] = useState(false);
  const [copiedEp, setCopiedEp] = useState(false);
  // 供应商条目（magpie 式）：展开看上游/模型面，获取模型 + 右键测试
  const [provOpen, setProvOpen] = useState(false);
  const [provBusy, setProvBusy] = useState(false);
  const [provResult, setProvResult] = useState(null);

  const copyEndpoint = async () => {
    try { await navigator.clipboard.writeText(endpointInput); setCopiedEp(true); setTimeout(() => setCopiedEp(false), 1200); } catch { /* noop */ }
  };

  const copyKey = async () => {
    const key = status?.apiKey || "";
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      // WebView2 剪贴板 API 不可用时退回 execCommand
      const ta = document.createElement("textarea");
      ta.value = key;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const refresh = async () => {
    try {
      const s = await invoke("gateway_status");
      setStatus(s);
      // 用户没动过输入框时跟随盘上真值（启动/换号后 key 会变）
      if (!keyTouched.current) setApiKey(s?.apiKey || "");
      if (!epTouched.current) setEndpointInput(`http://127.0.0.1:${s?.port ?? 8081}/v1`);
      // 配置对话框打开期间不回填任何调优输入：清空/编辑途中被 2s 轮询覆盖是打断
      if (!tuneOpenRef.current) {
        setConnectInput((v) => v || String(s?.upstreamConnectSecs ?? ""));
        setRetriesInput((v) => v || String(s?.maxRetries ?? ""));
        setBackoffInput((v) => v || String(s?.globalBackoffSecs ?? ""));
        setCorsInput((v) => v || (s?.corsOrigins || []).join(", "));
        setBodyLimitInput((v) => v || String(s?.bodyLimitMb ?? ""));
        setLogMaxInput((v) => v || String(s?.logFileMaxMb ?? ""));
        setFailsInput((v) => v || String(s?.allowedFails ?? ""));
        setKeepaliveInput((v) => v || String(s?.keepaliveSecs ?? ""));
        setTimeoutInput((v) => v || String(s?.totalTimeoutSecs ?? ""));
        setLogDiskInput(s?.logToDisk !== false);
        setStickyInput(s?.sticky !== false);
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  // 可见性感知轮询：托盘/最小化时 2s 全速轮询降为 30s，回前台立即补拉
  // （状态/池健康只在前台有意义，隐藏后全速轮询白打 IPC）
  useVisiblePolling(refresh, 2000, 30000, []);
  useEffect(() => { tuneOpenRef.current = tuneOpen; }, [tuneOpen]);
  // 协议 tab 左右邻居切换（Alt+←/→，循环）：只管调用示例的 Chat/Responses/Messages；
  // 测试弹窗的协议切换由 GatewayTestModal 自己监听（open 时才挂）
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      const order = ["chat", "responses", "messages"];
      setAccProto(order[(order.indexOf(accProto) + step + order.length) % order.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accProto]);

  const running = status?.running ?? false;
  // 网关重启检测（running false→true）：上次供应商测试结果对应的是旧进程，
  // 重启后上游状态可能已变，清掉避免展示陈旧结论
  const prevRunning = useRef(null);
  useEffect(() => {
    if (prevRunning.current === false && running) setProvResult(null);
    prevRunning.current = running;
  }, [running]);
  // 端点输入解析出的端口与盘上不一致 = 待保存；解析失败不给保存
  const parsedPort = parseEndpoint(endpointInput);
  const portDirty = status != null && parsedPort != null && parsedPort !== status.port;
  const keyDirty = keyTouched.current && apiKey.trim() !== (status?.apiKey || "");
  const tuneDirty = status != null && (
    String(status.upstreamConnectSecs ?? "") !== connectInput.trim() ||
    String(status.maxRetries ?? "") !== retriesInput.trim() ||
    String(status.globalBackoffSecs ?? "") !== backoffInput.trim() ||
    (status.corsOrigins || []).join(", ") !== corsInput.trim() ||
    String(status.bodyLimitMb ?? "") !== bodyLimitInput.trim() ||
    status.logToDisk !== logDiskInput ||
    String(status.logFileMaxMb ?? "") !== logMaxInput.trim() ||
    status.sticky !== stickyInput ||
    String(status.allowedFails ?? "") !== failsInput.trim() ||
    String(status.keepaliveSecs ?? "") !== keepaliveInput.trim() ||
    String(status.totalTimeoutSecs ?? "") !== timeoutInput.trim()
  );
  const guard = async (fn) => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const doStart = () => guard(async () => {
    await invoke("gateway_start", { port: null, apiKey: null });
  });
  // 页面上的基础保存：端口（从端点 URL 解析）+ 密钥一起落盘，调优沿用盘上值
  const doSaveBase = () => guard(async () => {
    const p = parseEndpoint(endpointInput);
    if (p == null) throw new Error(t("x.badPort"));
    await invoke("gateway_start", { port: p, apiKey: apiKey.trim() || null });
    keyTouched.current = false;
    epTouched.current = false;
    setEndpointInput(`http://127.0.0.1:${p}/v1`);
    setApiKey(status?.apiKey || apiKey.trim());
  });
  // 配置对话框保存：只写调优项，端口/密钥传 null 沿用盘上值
  const doSaveTune = () => guard(async () => {
    const conn = parseInt(connectInput.trim(), 10);
    const ret = parseInt(retriesInput.trim(), 10);
    const back = parseInt(backoffInput.trim(), 10);
    const bl = parseInt(bodyLimitInput.trim(), 10);
    const lm = parseInt(logMaxInput.trim(), 10);
    await invoke("gateway_start", {
      port: null,
      apiKey: null,
      upstreamConnectSecs: Number.isFinite(conn) && conn > 0 ? conn : null,
      maxRetries: Number.isFinite(ret) && ret >= 0 ? ret : null,
      globalBackoffSecs: Number.isFinite(back) && back > 0 ? back : null,
      corsOrigins: corsInput.trim() ? corsInput.split(",").map((s) => s.trim()).filter(Boolean) : null,
      bodyLimitMb: Number.isFinite(bl) && bl > 0 ? bl : null,
      logToDisk: logDiskInput,
      logFileMaxMb: Number.isFinite(lm) && lm > 0 ? lm : null,
      sticky: stickyInput,
      allowedFails: Number.isFinite(parseInt(failsInput.trim(), 10)) ? Math.max(0, parseInt(failsInput.trim(), 10)) : null,
      keepaliveSecs: Number.isFinite(parseInt(keepaliveInput.trim(), 10)) ? Math.max(0, parseInt(keepaliveInput.trim(), 10)) : null,
      totalTimeoutSecs: Number.isFinite(parseInt(timeoutInput.trim(), 10)) ? Math.max(0, parseInt(timeoutInput.trim(), 10)) : null,
    });
    setTuneOpen(false);
  });
  const doStop = () => guard(async () => {
    await invoke("gateway_stop");
  });

  const endpoint = `http://127.0.0.1:${status?.port ?? 8081}/v1`;
  // 池排序：熔断 > 冷却 > 在飞 > 正常，异常天然排前（摘要条计数用）
  const poolSorted = useMemo(() => {
    const ms = status?.pool?.members || [];
    const rank = (m) => (m.cooldown_secs >= 600 ? 0 : m.cooldown_secs > 0 ? 1 : m.inflight > 0 ? 2 : 3);
    return [...ms].sort((a, b) => rank(a) - rank(b));
  }, [status]);
  // 调用示例随 tab 切换：Chat（/chat/completions）/ Responses（/responses）/ Messages（/messages），真实端点 + 真实 key + 真实模型名
  const modelShown = (status?.models?.length ? status.models : ["GLM-5.3-Flash"])[0];
  // 示例恒用占位符：key 输入框默认打码的意图不能被下方 curl 明文破坏，抄用后自行替换
  const keyShown = "<API_KEY>";
  const accessCurl =
    accProto === "responses"
      ? `curl ${endpoint}/responses \\\n` +
        `  -H "Authorization: Bearer ${keyShown}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{"model":"${modelShown}","input":"hi","max_output_tokens":256}'`
      : accProto === "messages"
        ? `curl ${endpoint}/messages \\\n` +
          `  -H "Authorization: Bearer ${keyShown}" \\\n` +
          `  -H "anthropic-version: 2023-06-01" \\\n` +
          `  -H "Content-Type: application/json" \\\n` +
          `  -d '{"model":"${modelShown}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`
        : `curl ${endpoint}/chat/completions \\\n` +
          `  -H "Authorization: Bearer ${keyShown}" \\\n` +
          `  -H "Content-Type: application/json" \\\n` +
          `  -d '{"model":"${modelShown}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`;
  const copyExample = async () => {
    try { await navigator.clipboard.writeText(accessCurl); setCopiedEx(true); setTimeout(() => setCopiedEx(false), 1200); } catch { /* noop */ }
  };

  // 供应商动作（magpie 式）：获取模型（回缓存/拉取）+ 右键测试（tiny 请求，独立直连不碰池）
  const doFetchModels = () => guard(async () => {
    const r = await invoke("provider_fetch_models", { providerId: "zcode" });
    await refresh();
    toast(t("x.fetchedModels", { n: (r.models || []).length }));
  });
  const doProvTest = () => guard(async () => {
    setProvResult({ testing: true });
    try {
      const r = await invoke("provider_test", { providerId: "zcode", accountId: null });
      setProvResult(r);
    } catch (e) {
      // 测试失败：条目行 tag 换成失败态（不然挂在「测试中…」不可恢复），错误全文交 guard toast
      setProvResult({ ok: false, status: null, error: stripErr(e) });
      throw e;
    }
  });

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          Gateway{status ? <span className="ver">: {running ? t("x.running") : t("x.stopped")}</span> : null}
        </div>
        <div className="top-status">
          <span className={"status-dot " + (running ? "run" : "off")} />
          <span className="status-text">{running ? t("x.running") : t("x.stopped")}</span>
        </div>
      </header>
      <section className="toolbar">
        {running
          ? <button className="btn-ghost has-ic" disabled={busy} onClick={doStop}><Ic name="power" size={15} /> {t("x.stop")}</button>
          : <button className="btn-primary has-ic" disabled={busy} onClick={doStart}><Ic name="play" size={15} /> {t("x.start")}</button>}
        <button className="btn-ghost has-ic" disabled={busy || !running}
          onClick={() => setTestOpen(true)}><Ic name="capture" size={15} /> {t("x.testBtn")}</button>
        <button className="btn-ghost has-ic" onClick={() => setTuneOpen(true)}><Ic name="sliders" size={15} /> {t("x.cfgBtn")}</button>
        {onOpenLogs
          ? <button className="btn-ghost has-ic" onClick={onOpenLogs}><Ic name="list" size={15} /> {t("xl.menuLabel")}</button>
          : null}
        <span className="tb-spacer" />
      </section>
      <section className="settings open gw-page">
        <label>{t("x.endpointLabel")}</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={endpointInput}
            onChange={(e) => { epTouched.current = true; setEndpointInput(e.target.value); }}
            placeholder="http://127.0.0.1:8081/v1" />
          <button className="btn-ghost has-ic" title={t("x.copyKey")} onClick={copyEndpoint}><Ic name="copy" size={14} /></button>
          {portDirty
            ? <button className="btn-primary" disabled={running || busy} onClick={doSaveBase}>{t("common.save")}</button>
            : null}
        </div>

        <label style={{ marginTop: 10 }}>API KEY</label>
        <div className="path-line">
          <input className="zcode-path" type={showKey ? "text" : "password"} value={apiKey}
            onChange={(e) => { keyTouched.current = true; setApiKey(e.target.value); }}
            placeholder={t("x.apiKeyPh")} />
          {apiKey
            ? <button className="btn-ghost has-ic" title={showKey ? t("x.hideKey") : t("x.showKey")}
                onClick={() => setShowKey(!showKey)}><Ic name={showKey ? "eyeOff" : "eye"} size={14} /></button>
            : null}
          {status?.apiKey
            ? <button className="btn-ghost" onClick={copyKey}>{copied ? t("x.copied") : t("x.copyKey")}</button>
            : null}
          {keyDirty
            ? <button className="btn-primary" disabled={running || busy} onClick={doSaveBase}>{t("common.save")}</button>
            : null}
        </div>
        {running && (keyDirty || portDirty) ? <div className="hint">{t("x.cfgRunningHint")}</div> : null}

        <label style={{ marginTop: 14 }}>{t("x.exampleLabel")}</label>
        <div className="lang-seg x-proto-seg" style={{ marginBottom: 8 }}>
          <button className={"lang-opt" + (accProto === "chat" ? " on" : "")} onClick={() => setAccProto("chat")}>Chat</button>
          <button className={"lang-opt" + (accProto === "responses" ? " on" : "")} onClick={() => setAccProto("responses")}>Responses</button>
          <button className={"lang-opt" + (accProto === "messages" ? " on" : "")} onClick={() => setAccProto("messages")}>Messages</button>
        </div>
        <pre className="x-curl">{accessCurl}</pre>
        <div className="path-line" style={{ marginTop: 6 }}>
          <button className="btn-ghost" onClick={copyExample}>{copiedEx ? t("x.copied") : t("x.copyBtn")}</button>
          {err ? <span className="hint" style={{ color: "var(--red)" }}>{err}</span> : null}
        </div>
        <div className="hint">{t("x.endpointDesc")}</div>

        {/* 账号池：一行摘要条，点击跳账号管理页定位；明细在账号页看，不在主页堆 */}
        <label style={{ marginTop: 14 }}>{t("x.poolLabel")}</label>
        {status?.pool?.members?.length
          ? <>
              {/* hover 明细：每号模型面（null=未拉取未知，[]=确认无桶） */}
              <div
                className="x-pool-line"
                title={poolSorted.map((m) => `${m.name}: ${Array.isArray(m.models) ? (m.models.length ? m.models.join(", ") : t("x.poolNoBuckets")) : t("x.poolUnknown")}`).join("\n")}
                onClick={() => onOpenAccount?.()}
              >
                <Ic name="list" size={14} />
                <span>{t("x.poolSummary", {
                  n: poolSorted.filter((m) => !(m.cooldown_secs > 0)).length,
                  cool: poolSorted.filter((m) => m.cooldown_secs > 0).length,
                  inflight: poolSorted.reduce((a, m) => a + (m.inflight || 0), 0),
                  total: poolSorted.length,
                })}</span>
                {status.pool.global_backoff_secs > 0
                  ? <span className="x-pool-tag warn">{t("x.globalBackoff")} {status.pool.global_backoff_secs}s</span>
                  : null}
                <span className="x-pool-caret">▸</span>
              </div>
              {/* 模型面并集（/v1/models 同源）：对外可请求的模型一目了然 */}
              {status.models?.length
                ? <div className="x-pool-models">
                    {status.models.map((n) => <span key={n} className="x-pool-tag model">{n}</span>)}
                  </div>
                : null}
            </>
          : <div className="x-log-empty"><Ic name="empty" size={16} /><span>{t("x.poolEmpty")}</span></div>}

        {/* 供应商条目（magpie 式）：展开看上游/模型面，获取模型 + 右键测试（tiny 请求独立直连不碰池） */}
        <div
          className="x-pool-line"
          style={{ marginTop: 14 }}
          onClick={() => setProvOpen(!provOpen)}
          onContextMenu={(e) => { e.preventDefault(); if (!provBusy) doProvTest(); }}
          title={t("x.provTest") + "（右键）"}
        >
          <Ic name="sliders" size={14} />
          <span>ZCode · zcode.z.ai</span>
          {provBusy
            ? <span className="x-pool-tag">{t("x.provTesting")}</span>
            : provResult && !provResult.testing
              ? provResult.ok
                ? <span className="x-pool-tag ok">{t("x.provOk", { ms: provResult.ms })}</span>
                : <span className="x-pool-tag warn" title={String(provResult.error || "")}>
                    {t("x.provFail", { status: provResult.status ?? "—", error: String(provResult.error || "").slice(0, 24) })}
                  </span>
              : null}
          <span className="x-pool-caret">{provOpen ? "▾" : "▸"}</span>
        </div>
        {provOpen
          ? <div className="x-pool-models">
              <button className="btn-ghost" disabled={provBusy} onClick={doFetchModels}>
                <Ic name="capture" size={13} /> {t("x.fetchModelsBtn")}
              </button>
              <button className="btn-ghost" disabled={provBusy} onClick={doProvTest} title={t("x.provTest")}>
                <Ic name="bolt" size={13} /> {t("x.provTest")}
              </button>
            </div>
          : null}
      </section>

      {tuneOpen
        ? <div className="pv-mask" onClick={() => setTuneOpen(false)}>
            <div className="pv-panel x-tune-panel" onClick={(e) => e.stopPropagation()}>
              <div className="pv-title">{t("x.cfgTitle")}</div>
              <div className="pv-sub">{t("x.tuneHint")}</div>
              <label>{t("x.tuneGroupNet")}</label>
              <div className="x-tune">
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneConnect")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={connectInput}
                    onChange={(e) => setConnectInput(e.target.value)} placeholder="15" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneRetries")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={retriesInput}
                    onChange={(e) => setRetriesInput(e.target.value)} placeholder="1" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneBackoff")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={backoffInput}
                    onChange={(e) => setBackoffInput(e.target.value)} placeholder="600" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneFails")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={failsInput}
                    onChange={(e) => setFailsInput(e.target.value)} placeholder="5" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneKeepalive")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={keepaliveInput}
                    onChange={(e) => setKeepaliveInput(e.target.value)} placeholder="15" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneTimeout")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={timeoutInput}
                    onChange={(e) => setTimeoutInput(e.target.value)} placeholder="600" />
                </div>
              </div>
              <label style={{ marginTop: 14 }}>{t("x.tuneGroupSrv")}</label>
              <div className="x-tune">
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneCors")}</span>
                  <input className="zcode-path" type="text" value={corsInput}
                    onChange={(e) => setCorsInput(e.target.value)} placeholder="https://a.example, https://b.example | * 放行全部" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneBodyLimit")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={bodyLimitInput}
                    onChange={(e) => setBodyLimitInput(e.target.value)} placeholder="32" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneLogMax")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={logMaxInput}
                    onChange={(e) => setLogMaxInput(e.target.value)} placeholder="16" />
                </div>
              </div>
              <div className="x-tune-switch">
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneLogDisk")}</span>
                  <button className={"tog-inline" + (logDiskInput ? " on" : "")} role="switch" aria-checked={logDiskInput}
                    onClick={() => setLogDiskInput(!logDiskInput)}>
                    <span className={"toggle" + (logDiskInput ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
                    {logDiskInput ? t("x.tuneLogOn") : t("x.tuneLogOff")}
                  </button>
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneSticky")}</span>
                  <button className={"tog-inline" + (stickyInput ? " on" : "")} role="switch" aria-checked={stickyInput}
                    onClick={() => setStickyInput(!stickyInput)}>
                    <span className={"toggle" + (stickyInput ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
                    {stickyInput ? t("x.stickyOn") : t("x.stickyOff")}
                  </button>
                </div>
              </div>
              <div className="pv-actions">
                <button className="btn-ghost" onClick={() => setTuneOpen(false)}>{t("common.cancel")}</button>
                <button className="btn-primary" disabled={!tuneDirty || busy} onClick={() => guard(doSaveTune)}>
                  {t("common.save")}
                </button>
              </div>
            </div>
          </div>
        : null}

      {/* 测试弹窗：状态与请求逻辑自包含（模型下拉 / stream 开关 / SSE / 历史），组件内处理 Alt+←/→ */}
      <GatewayTestModal open={testOpen} onClose={() => setTestOpen(false)}
        status={status} running={running} guard={guard} endpoint={endpoint} apiKey={apiKey} />
    </>
  );
}
