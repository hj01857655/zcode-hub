// React 版 Gateway 页：反代服务控制面板（M1 接线 gateway_start/stop/status）
// 布局与设置页同构（靠左表单流 .settings），状态区置顶。
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t, stripErr } from "../lib/i18n.js";
import { toast } from "../components/ui-bus.js";
import { Ic } from "../components/iconsx.jsx";
import { GatewayTestModal } from "../components/gateway-test.jsx";
import { useVisiblePolling } from "../lib/pageVisible.js";

// 三种协议客户端要填的 base URL 不同：Chat/Responses 带 /v1（客户端追加
// /chat/completions、/responses），Anthropic 不带 /v1（客户端自己追加 /v1/messages）。
// 输入框随协议 tab 切换，Anthropic 下填 /v1 会拼出 /v1/v1/messages。
const protocolBase = (port, proto) =>
  `http://127.0.0.1:${port}${proto === "messages" ? "" : "/v1"}`;

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
  // 2s 轮询的 refresh 闭包是挂载时那一份（deps=[]），读不到新 accProto；
  // 用 ref 让回填始终按当前协议算 base，否则轮询会把 Messages 的根地址盖回 /v1
  const accProtoRef = useRef(accProto);
  useEffect(() => {
    accProtoRef.current = accProto;
    if (!epTouched.current) setEndpointInput(protocolBase(status?.port ?? 8081, accProto));
  }, [accProto]);
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
  // 代理池表单：mode 三态（off/single/pool），pool 用多行文本域每行一条
  // 出网代理池配置统一在设置页维护；网关页仅展示状态摘要（proxyStats）
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
  const [provBusy, setProvBusy] = useState(false);
  // 测试结果弹窗：{ ok, status, ms, error, model, account }，null=关闭
  const [testResult, setTestResult] = useState(null);
  // 获取模型结果：{ models, cached, at }——只弹 toast 会把清单丢掉，落进 state
  // 常驻展示（清单/来源/时刻）。未点过「获取模型」时回退到 status.models
  // （gateway_status 与 /v1/models 同源），不必等用户先点一次才能右键测
  const [provModels, setProvModels] = useState(null);
  const shownModels = provModels ?? (status?.models?.length
    ? { models: status.models, src: null, at: null }
    : null);
  // 运行时保存落盘后服务仍用启动时快照，给一条明确提示而不是静默失败
  const [savedRestart, setSavedRestart] = useState(false);

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
      setErr("");
      // 用户没动过输入框时跟随盘上真值（启动/换号后 key 会变）
      if (!keyTouched.current) setApiKey(s?.apiKey || "");
      if (!epTouched.current) setEndpointInput(protocolBase(s?.port ?? 8081, accProtoRef.current));
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
  // 弹窗统一 Esc 关闭：最上层优先（测试结果 > 调优 > 通道测试），一次只关一个
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (testResult) { setTestResult(null); return; }
      if (tuneOpen) { setTuneOpen(false); return; }
      if (testOpen) setTestOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [testResult, tuneOpen, testOpen]);
  // 协议 tab 左右邻居切换（Alt+←/→，循环）：只管调用示例的 Chat/Responses/Messages；
  // 测试弹窗的协议切换由 GatewayTestModal 自己监听（open 时才挂）——这里必须让出，
  // 否则弹窗开着按一次会同时切页面 tab 和弹窗 tab
  useEffect(() => {
    if (testOpen) return undefined;
    const onKey = (e) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      const order = ["chat", "responses", "messages"];
      setAccProto(order[(order.indexOf(accProto) + step + order.length) % order.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accProto, testOpen]);

  const running = status?.running ?? false;
  // 网关重启检测（running false→true）：上次模型测试结果对应的是旧进程，
  // 重启后上游状态可能已变，清掉避免展示陈旧结论
  const prevRunning = useRef(null);
  useEffect(() => {
    if (prevRunning.current === false && running) setTestResult(null);
    prevRunning.current = running;
    // 用户手动启停后配置已重新加载，不再挂「待重启」横幅
    if (!running) setSavedRestart(false);
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
  // busy 是全局闸门；供应商动作额外用 provBusy 钉住自己的按钮/右键/重测，
  // 避免测试弹窗开着时连点发出多条上游请求
  const guard = async (fn, providerAction = false) => {
    if (busy) return;
    setBusy(true);
    if (providerAction) setProvBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      setBusy(false);
      if (providerAction) setProvBusy(false);
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
    // 后端忽略空串（且空 key = 拒绝所有请求），留空保存会静默失败：
    // 界面显示已保存、盘上还是旧值，必须先拦住
    const key = apiKey.trim();
    if (!key) throw new Error(t("x.keyNotEmpty"));
    await invoke("gateway_start", { port: p, apiKey: key });
    keyTouched.current = false;
    epTouched.current = false;
    setEndpointInput(protocolBase(p, accProto));
    // 回填用本次提交的值：status 还是保存前的快照，回读它会把刚提交的新 key 丢掉
    setApiKey(key);
    if (running) setSavedRestart(true);
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
    if (running) setSavedRestart(true);
  });
  const doStop = () => guard(async () => {
    await invoke("gateway_stop");
  });
  const doRestart = () => guard(async () => {
    await invoke("gateway_stop");
    await invoke("gateway_start", { port: null, apiKey: null });
    setSavedRestart(false);
  });

  const endpoint = `http://127.0.0.1:${status?.port ?? 8081}/v1`;
  // 池排序：熔断 > 冷却 > 在飞 > 正常，异常天然排前（摘要条计数用）
  const poolSorted = useMemo(() => {
    const ms = status?.pool?.members || [];
    const rank = (m) => (m.cooldown_secs >= 600 ? 0 : m.cooldown_secs > 0 ? 1 : m.inflight > 0 ? 2 : 3);
    return [...ms].sort((a, b) => rank(a) - rank(b));
  }, [status]);
  // 出网代理池：mode≠off 才渲染摘要行；alive = 总数-冷却（cooling 含健康分触底死透）
  const proxyStats = status?.proxyStats || [];
  const proxyCool = proxyStats.filter((p) => p.cooling).length;
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

  // 供应商动作：获取模型（回缓存/拉取）+ 测试（tiny 请求，独立直连不碰池，绕开池轮转/熔断）
  const doFetchModels = () => guard(async () => {
    const r = await invoke("provider_fetch_models", { providerId: "zcode" });
    const list = Array.isArray(r.models) ? r.models : [];
    setProvModels({ models: list, src: !!r.cached ? "cached" : "live", at: new Date() });
    await refresh();
    toast(t("x.fetchedModels", { n: list.length }));
  }, true);
  // 测试指定模型：传模型名；行尾按钮不传 = 测清单首个。
  // 结果弹窗展示完整字段（状态/耗时/账号/错误全文），不再挤进行内小标签靠 hover 读
  const doProvTest = (model) => guard(async () => {
    const r = await invoke("provider_test", {
      providerId: "zcode", accountId: null, model: model || null,
    });
    setTestResult(r);
  }, true);

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
        {err ? <div className="hint" style={{ color: "var(--red)", marginBottom: 10 }}>{err}</div> : null}
        {/* 协议选择置顶：决定调用示例与接入形态，先选协议再看端点/密钥。
            不带 x-proto-seg（那是测试弹窗的面板内全宽形态）；fit-content 收住胶囊，
            块级 div 默认占满行宽会让三颗小按钮拖着一条整行空胶囊 */}
        <div className="lang-seg" style={{ width: "fit-content", marginBottom: 10 }}>
          <button className={"lang-opt" + (accProto === "chat" ? " on" : "")} onClick={() => setAccProto("chat")}>Chat</button>
          <button className={"lang-opt" + (accProto === "responses" ? " on" : "")} onClick={() => setAccProto("responses")}>Responses</button>
          <button className={"lang-opt" + (accProto === "messages" ? " on" : "")} onClick={() => setAccProto("messages")}>Messages</button>
        </div>
        <label>{t("x.endpointLabel")}</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={endpointInput}
            onChange={(e) => { epTouched.current = true; setEndpointInput(e.target.value); }}
            placeholder={protocolBase(status?.port ?? 8081, accProto)} />
          <button className="btn-ghost has-ic" title={t("x.copyEndpoint")} onClick={copyEndpoint}>
            <Ic name={copiedEp ? "check" : "copy"} size={14} />
          </button>
          {portDirty
            ? <button className="btn-primary" disabled={busy} onClick={doSaveBase}>{t("common.save")}</button>
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
            ? <button className="btn-ghost has-ic" title={copied ? t("x.copied") : t("x.copyKey")} onClick={copyKey}>
                <Ic name={copied ? "check" : "copy"} size={14} />
              </button>
            : null}
          {keyDirty
            ? <button className="btn-primary" disabled={busy} onClick={doSaveBase}>{t("common.save")}</button>
            : null}
        </div>
        {running && (keyDirty || portDirty) ? <div className="hint">{t("x.cfgRunningHint")}</div> : null}
        {savedRestart
          ? <div className="x-restart-bar">
              <span>{t("x.savedRestartHint")}</span>
              <button className="btn-primary" disabled={busy} onClick={doRestart}>
                <Ic name="refresh" size={13} /> {t("x.restart")}
              </button>
            </div>
          : null}

        <label style={{ marginTop: 14 }}>{t("x.exampleLabel")}</label>
        <pre className="x-curl">{accessCurl}</pre>
        <div className="path-line" style={{ marginTop: 6 }}>
          <button className="btn-ghost has-ic" title={copiedEx ? t("x.copied") : t("x.copyBtn")} onClick={copyExample}>
            <Ic name={copiedEx ? "check" : "copy"} size={14} />
          </button>
        </div>
        <div className="hint">{t("x.endpointDesc")}</div>
        {accProto === "messages" ? <div className="hint">{t("x.endpointAnthropicNote")}</div> : null}

        {/* 账号池：一行摘要条，点击跳账号管理页定位；明细在账号页看，不在主页堆 */}
        <label style={{ marginTop: 14 }}>{t("x.poolLabel")}</label>
        {status?.pool?.members?.length
          ? <>
              {/* hover 明细：第一行对外可用模型并集（/v1/models 同源），随后每号模型面——
                  页面不渲染常驻模型行，能力视图只进 hover，主页面保持单行摘要 */}
              <div
                className="x-pool-line"
                title={(() => {
                  const lines = [];
                  if (status.models?.length) lines.push(`${t("x.modelsAvail")}: ${status.models.join(", ")}`);
                  lines.push(...poolSorted.map((m) => `${m.name}: ${Array.isArray(m.models) ? (m.models.length ? m.models.join(", ") : t("x.poolNoBuckets")) : t("x.poolUnknown")}`));
                  return lines.join("\n");
                })()}
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
            </>
          : <div className="x-log-empty"><Ic name="empty" size={16} /><span>{t("x.poolEmpty")}</span></div>}

        {/* 出网代理池：一行摘要（hover 明细 = 每出口脱敏串/健康分/绑定/冷却） */}
        {status?.proxyMode && status.proxyMode !== "off"
          ? proxyStats.length
            ? <div className="x-pool-line" style={{ marginTop: 8, cursor: "default" }}
                title={proxyStats.map((p) => `${p.url} · ${t("x.proxyScore")} ${p.score} · ${t("x.proxyBind")} ${p.bindings}${p.cooling ? ` · ${t("x.proxyCooling")}` : ""}`).join("\n")}>
                <Ic name="swap" size={14} />
                <span>{t("x.proxyLabel")} · {t("x.proxySummary", { alive: proxyStats.length - proxyCool, cool: proxyCool, total: proxyStats.length })}</span>
                {proxyCool ? <span className="x-pool-tag warn">{t("x.proxyCooling")} {proxyCool}</span> : null}
              </div>
            : <div className="x-pool-line" style={{ marginTop: 8, cursor: "default" }}>
                <Ic name="alert" size={14} />
                <span className="x-pool-tag warn">{t("x.proxyInvalid")}</span>
              </div>
          : null}

        {/* 上游供应商：单通道压成一行——host + 模型数（hover 展开清单）；动作只留
            刷新模型面与单号直连测试两个小按钮，来源/时刻一并进行内 tag */}
        <div className="x-pool-line" style={{ marginTop: 14, cursor: "default" }}
          title={shownModels?.models?.length
            ? `${t("x.modelsAvail")}:\n${shownModels.models.join("\n")}`
            : t("x.modelsNone")}>
          <Ic name="sliders" size={14} />
          <span>ZCode · zcode.z.ai · {t("x.modelsAvail")} {shownModels?.models?.length ?? 0}</span>
          {provBusy ? <span className="x-pool-tag">{t("x.provTesting")}</span> : null}
          {shownModels?.src
            ? <span className="x-pool-tag">
                {t(shownModels.src === "cached" ? "x.modelsFromCache" : "x.modelsFromUpstream")}
                {shownModels.at ? ` · ${shownModels.at.toLocaleTimeString()}` : ""}
              </span>
            : null}
          <span className="tb-spacer" />
          <button className="btn-ghost has-ic" disabled={provBusy} onClick={doFetchModels}
            title={t("x.fetchModelsBtn")}>
            <Ic name="refresh" size={13} />
          </button>
          <button className="btn-ghost has-ic" disabled={provBusy || !shownModels?.models?.length}
            onClick={() => doProvTest(null)} title={t("x.provTestFirst")}>
            <Ic name="bolt" size={13} />
          </button>
        </div>
      </section>

      {/* 模型测试结果弹窗：完整字段常驻可读，不再挤进行内小标签靠 hover 读错误全文 */}
      {testResult
        ? <div className="pv-mask" onClick={() => setTestResult(null)}>
            <div className="pv-panel x-test-result" onClick={(e) => e.stopPropagation()}>
              <div className="pv-title">
                <span className={"x-test-result-dot " + (testResult.ok ? "ok" : "bad")} />
                {t(testResult.ok ? "x.testResultOk" : "x.testResultFail")}
              </div>
              <div className="pv-sub">{t("x.testResultSub")}</div>
              <div className="x-test-result-grid">
                <span>{t("x.testResultModel")}</span><code>{String(testResult.model ?? "—")}</code>
                <span>{t("x.testResultStatus")}</span><code>{testResult.status ?? "—"}</code>
                <span>{t("x.testResultMs")}</span><code>{testResult.ms ?? "—"} ms</code>
                <span>{t("x.testResultAccount")}</span><code>{String(testResult.account ?? "—")}</code>
              </div>
              {testResult.error
                ? <div className="x-test-result-err">
                    <div className="x-test-result-err-head">{t("x.testResultError")}</div>
                    <pre>{String(testResult.error)}</pre>
                  </div>
                : null}
              <div className="x-test-result-actions">
                <button className="btn-ghost has-ic" onClick={() => setTestResult(null)}>{t("common.close")}</button>
                <button className="btn-primary has-ic" disabled={provBusy}
                  onClick={() => doProvTest(testResult.model)}>
                  <Ic name="refresh" size={13} /> {provBusy ? t("x.provTesting") : t("x.provTest")}
                </button>
              </div>
            </div>
          </div>
        : null}

      {tuneOpen
        ? <div className="pv-mask" onClick={() => setTuneOpen(false)}>
            <div className="pv-panel x-tune-panel" onClick={(e) => e.stopPropagation()}>
              <div className="pv-title">{t("x.cfgTitle")}</div>
              <div className="pv-sub">{t("x.tuneHint")}</div>
              <div className="x-tune-section">
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
              </div>
              <div className="x-tune-section">
              <label>{t("x.tuneGroupSrv")}</label>
              <div className="x-tune">
                <div className="x-tune-item x-tune-wide">
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
                    title={t("x.tuneStickyHint")}
                    onClick={() => setStickyInput(!stickyInput)}>
                    <span className={"toggle" + (stickyInput ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
                    {stickyInput ? t("x.stickyOn") : t("x.stickyOff")}
                  </button>
                </div>
              </div>
              </div>
              <div className="hint">{t("x.proxyHintNowInSettings")}</div>
              <div className="pv-actions">
                <button className="btn-ghost" onClick={() => setTuneOpen(false)}>{t("common.cancel")}</button>
                <button className="btn-primary" disabled={!tuneDirty || busy} onClick={doSaveTune}>
                  {t("common.save")}
                </button>
              </div>
            </div>
          </div>
        : null}

      {/* 测试弹窗：状态与请求逻辑自包含（模型下拉 / stream 开关 / SSE / 历史），组件内处理 Alt+←/→ */}
      <GatewayTestModal open={testOpen} onClose={() => setTestOpen(false)}
        status={status} running={running} guard={guard} endpoint={endpoint} apiKey={status?.apiKey || ""} />
    </>
  );
}
