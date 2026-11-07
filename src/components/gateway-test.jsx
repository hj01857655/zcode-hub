// React 版 Gateway 测试弹窗：请求体 JSON 编辑 + 三协议 tab（Chat / Responses / Messages），发真请求看结果
// 状态与请求逻辑自包含；Alt+←/→ 切相邻协议 tab（循环），切档重置默认体
import { useEffect, useRef, useState } from "react";
import { t, stripErr } from "../lib/i18n.js";

export function GatewayTestModal({ open, onClose, status, running, guard, endpoint, apiKey }) {
  const [testProto, setTestProto] = useState("openai");
  const [testBody, setTestBody] = useState("");
  const [testShowCode, setTestShowCode] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testHistory, setTestHistory] = useState([]);
  const testAbort = useRef(null);

  const switchProto = (step) => {
    const order = ["openai", "responses", "anthropic"];
    setTestProto(order[(order.indexOf(testProto) + step + order.length) % order.length]);
    setTestBody("");
  };
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      switchProto(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, testProto]);

  // 请求体直接以 JSON 编辑（model/stream/参数全在体里，协议 tab 只决定端点路径与 anthropic-version 头）
  const defaultTestBody = () => JSON.stringify(
    testProto === "responses"
      ? { model: (status?.models?.length ? status.models : ["GLM-5.3-Flash"])[0], input: "hi", max_output_tokens: 256, stream: false }
      : { model: (status?.models?.length ? status.models : ["GLM-5.3-Flash"])[0], max_tokens: 256, stream: false, messages: [{ role: "user", content: "hi" }] },
    null, 2);
  let testBodyParsed = {};
  try { testBodyParsed = JSON.parse(testBody || defaultTestBody()); } catch { /* 非法 JSON：curl 预览退空体 */ }

  // 动态模型面：gateway_status 与 /v1/models 同源（周卡/夜卡 entitlements 并集）
  const models = status?.models?.length ? status.models : ["GLM-5.3-Flash"];

  // 快捷补丁：解析当前体 → 改字段 → 回写编辑框（非法 JSON 退回默认体）
  const patchBody = (patch) => {
    let obj = {};
    try { obj = JSON.parse(testBody || defaultTestBody()); } catch { obj = JSON.parse(defaultTestBody()); }
    setTestBody(JSON.stringify({ ...obj, ...patch }, null, 2));
  };

  // Responses 非流式出站取文本：优先 output_text 便捷字段，否则沿 output[].content[].text 拼接
  const responsesText = (rb) => rb?.output_text
    || (Array.isArray(rb?.output)
      ? rb.output.flatMap((o) => (Array.isArray(o?.content) ? o.content.map((c) => c?.text ?? "") : [])).join("")
      : "");

  const doTestSend = () => guard(async () => {
    setTestBusy(true);
    setTestResult(null);
    // 可取消：流式长生成中途能停；AbortError 单独落「已取消」，不进错误 toast
    testAbort.current?.abort();
    const ac = new AbortController();
    testAbort.current = ac;
    const t0 = Date.now();
    try {
      const anthropic = testProto === "anthropic";
      const path = anthropic ? "/messages" : testProto === "responses" ? "/responses" : "/chat/completions";
      let body;
      try {
        body = JSON.parse(testBody || defaultTestBody());
      } catch {
        setTestResult({ ok: false, status: 0, ms: Date.now() - t0, text: t("x.testBadJson"), stream: false, proto: testProto });
        setTestBusy(false);
        return;
      }
      const streaming = body?.stream === true;
      const r = await fetch(`${endpoint}${path}`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Authorization": `Bearer ${apiKey || status?.apiKey || ""}`,
          "Content-Type": "application/json",
          ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
        },
        body: JSON.stringify(body),
      });
      let text = "";
      let usage = null;
      let ttft = null;
      const pullFrame = (d) => {
        if (d === "[DONE]") return;
        try {
          const v = JSON.parse(d);
          if (ttft == null) ttft = Date.now() - t0; // 首帧即 TTFT
          text += (anthropic ? v?.delta?.text : testProto === "responses" ? v?.delta : v?.choices?.[0]?.delta?.content) ?? "";
          // 合并而非覆盖：Anthropic 的 usage 分帧下发（message_start 给 input，message_delta 给 output）
          usage = { ...(usage || {}), ...(v?.usage || {}), ...(v?.response?.usage || {}) };
        } catch { /* 非 JSON 帧跳过 */ }
      };
      if (streaming && r.ok) {
        // 流式：逐帧读 SSE；OpenAI 拼 delta.content，Anthropic 拼 delta.text，Responses 拼 delta 字符串
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) pullFrame(line.slice(6).trim());
          }
        }
        // 收尾 flush：末尾无换行的残留帧也吃掉，不丢结尾
        if (buf.startsWith("data: ")) pullFrame(buf.slice(6).trim());
      } else {
        const rb = await r.json().catch(() => ({}));
        text = r.ok
          ? (anthropic
              ? (rb?.content?.find?.((b) => b?.type === "text")?.text || responsesText(rb) || JSON.stringify(rb).slice(0, 400))
              : testProto === "responses"
                ? (responsesText(rb) || JSON.stringify(rb).slice(0, 400))
                : (rb?.choices?.[0]?.message?.content || JSON.stringify(rb).slice(0, 400)))
          : (rb?.error?.message || JSON.stringify(rb).slice(0, 300));
        usage = rb?.usage ?? null;
      }
      const tin = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
      const tout = usage?.completion_tokens ?? usage?.output_tokens ?? null;
      const res = { ok: r.ok, status: r.status, ms: Date.now() - t0, text: String(text), stream: streaming, proto: testProto, ttft, usage, tin, tout };
      setTestResult(res);
      setTestHistory((h) => [res, ...h].slice(0, 5));
    } catch (e) {
      if (e?.name === "AbortError") {
        setTestResult({ ok: false, status: 0, ms: Date.now() - t0, text: t("x.testAborted"), stream: false, proto: testProto });
      } else {
        // 非 Abort 的 fetch 异常（连接拒绝/DNS 失败——网关没启动就点测试时必现）：
        // 必须落 testResult 可见。此前 throw 给外层 guard 的 setErr，但那个 err
        // 渲染在页面主区的 curl 下方，弹窗开着时用户看不到，表现为「点了没反应」。
        // 诊断化：连接类失败带可操作建议（去网关页启动服务），并把 running 状态带进结果
        const msg = stripErr(e);
        const connFail = /failed to fetch|networkerror|load failed|connection refused|fetch failed/i.test(msg) && !running;
        setTestResult({
          ok: false, status: 0, ms: Date.now() - t0,
          text: connFail ? t("x.testConnFail") : msg,
          hint: connFail ? t("x.testConnFailHint") : null,
          stream: false, proto: testProto,
        });
      }
    } finally {
      setTestBusy(false);
      testAbort.current = null;
    }
  });

  const testCurl =
    `curl ${endpoint}${testProto === "anthropic" ? "/messages" : testProto === "responses" ? "/responses" : "/chat/completions"} \\\n` +
    `  -H "Authorization: Bearer <API_KEY>" \\\n` +
    (testProto === "anthropic" ? `  -H "anthropic-version: 2023-06-01" \\\n` : "") +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '${JSON.stringify(testBodyParsed).replace(/'/g, "'\\''")}'`;

  if (!open) return null;
  return (
    <div className="pv-mask" onClick={onClose}>
      <div className="pv-panel x-test-panel" onClick={(e) => e.stopPropagation()}>
        <div className="x-test-head">
          <div className="pv-title">{t("x.testTitle")}</div>
          <button className="btn-ghost x-test-close" onClick={onClose}>×</button>
        </div>
        <div className="pv-sub">{t("x.testHint")}</div>
        <label className="x-test-label">{t("x.testProto")}</label>
        <div className="lang-seg x-proto-seg">
          <button className={"lang-opt" + (testProto === "openai" ? " on" : "")} onClick={() => { setTestProto("openai"); setTestBody(""); }}>Chat</button>
          <button className={"lang-opt" + (testProto === "responses" ? " on" : "")} onClick={() => { setTestProto("responses"); setTestBody(""); }}>Responses</button>
          <button className={"lang-opt" + (testProto === "anthropic" ? " on" : "")} onClick={() => { setTestProto("anthropic"); setTestBody(""); }}>Messages</button>
        </div>
        <div className="x-test-quick">
          <label className="x-test-label" htmlFor="x-test-model-sel">{t("x.testModel")}</label>
          <select id="x-test-model-sel" className="zcode-path x-test-model"
            value={testBodyParsed?.model || models[0]}
            onChange={(e) => patchBody({ model: e.target.value })}>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label className="x-test-stream-toggle">
            <input type="checkbox" checked={testBodyParsed?.stream === true}
              onChange={(e) => patchBody({ stream: e.target.checked })} />
            <span>{t("x.testStream")}</span>
          </label>
        </div>
        <label className="x-test-label">{t("x.testBodyLabel")}</label>
        <textarea className="zcode-path x-test-msg x-test-body" value={testBody || defaultTestBody()}
          onChange={(e) => setTestBody(e.target.value)} rows={10} spellCheck={false} />
        <div className="pv-actions x-test-actions">
          {testBusy
            ? <button className="btn-primary" onClick={() => testAbort.current?.abort()}>{t("x.stop")}</button>
            : <button className="btn-primary" disabled={!running} onClick={() => guard(doTestSend)}>{t("x.testSend")}</button>}
          <button className={"btn-ghost" + (testShowCode ? " x-btn-on" : "")} onClick={() => setTestShowCode(!testShowCode)}>curl</button>
          <button className="btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
        </div>
        {testShowCode
          ? <pre className="x-test-curl">{testCurl}</pre>
          : null}
        {testResult
          ? <>
              <label className="x-test-label">{t("x.testResult")}</label>
              <div className={"x-test-out" + (testResult.ok ? "" : " bad")}>
                <div className="x-test-meta">
                  <span className={"x-test-dot " + (testResult.ok ? "ok" : "bad")} />
                  {/* 状态语义：status=0 不是「HTTP 0」，按失败来源给可读词（连接失败/取消/非法体） */}
                  {testResult.status
                    ? `HTTP ${testResult.status} · `
                    : testResult.hint
                      ? `${t("x.testConnFail")} · `
                      : ""}
                  {testResult.ms}ms{testResult.stream ? ` · ${t("x.stream")}` : ""}{testResult.ttft != null ? ` · TTFT ${testResult.ttft}ms` : ""}
                  {(testResult.tin != null || testResult.tout != null)
                    ? ` · ${testResult.tout ?? 0}↑ / ${testResult.tin ?? 0}↓`
                    : ""}
                  {(testResult.usage?.cache_read_input_tokens != null || testResult.usage?.cache_creation_input_tokens != null)
                    ? ` · cache ${testResult.usage?.cache_read_input_tokens ?? 0}↺ / ${testResult.usage?.cache_creation_input_tokens ?? 0}+`
                    : ""}
                </div>
                <div className="x-test-text">{testResult.text}</div>
                {testResult.hint
                  ? <div className="x-test-hintline">{testResult.hint}</div>
                  : null}
              </div>
            </>
          : null}
        {testHistory.length > 1
          ? <>
              <label className="x-test-label">{t("x.testHistory")}</label>
              <div className="x-test-hist">
                {testHistory.slice(1).map((h, i) => (
                  <div key={i} className="x-test-hist-row">
                    <span className={"x-test-dot " + (h.ok ? "ok" : "bad")} />
                    <span className="x-test-hist-ms">{({ anthropic: "ANT", responses: "RSP", openai: "OAI" }[h.proto] || h.proto) + (h.stream ? "·SSE" : "")} · HTTP {h.status || "-"} · {h.ms}ms</span>
                    <span className="x-test-hist-text">{h.text.slice(0, 60)}</span>
                  </div>
                ))}
              </div>
            </>
          : null}
      </div>
    </div>
  );
}
