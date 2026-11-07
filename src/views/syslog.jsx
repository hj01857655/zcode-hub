// SysLog 页 — 系统日志：flowlog 尾部行（oauth/claim/switch/gateway/sys 五个流的运维事件）。
// 骨架复用请求日志页（topbar/toolbar/x-log-list），数据源 syslog_tail 命令；
// 行格式 `ts [flow] event detail`，按 [flow] 分组过滤、error 类事件着色。
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";
import { LogBlock, prettyJson } from "../components/LogBlock.jsx";
import { useVisiblePolling } from "../lib/pageVisible.js";

// 行解析（flowlog 文本行）：`2026-11-07 12:00:00 [flow] event detail...`
// 解析失败的行按 raw 展示（不静默吞）——日志格式是给程序读的，出现意外行本身就是要看到的事
function parseTextLine(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]]+)\] ?(.*)$/);
  if (!m) return { kind: "text", raw: line, ts: "", flow: "raw", event: line, detail: "" };
  const [, ts, flow, rest] = m;
  const sp = rest.indexOf(" ");
  const event = sp === -1 ? rest : rest.slice(0, sp);
  const detail = sp === -1 ? "" : rest.slice(sp + 1);
  return { kind: "text", raw: line, ts, flow, event, detail };
}

// 错误类事件名（着色与级别过滤的依据）：按事件名后缀/关键词判定
const ERR_EVENTS = ["fail", "error", "timeout", "corrupt", "downgraded"];
const isErrEvent = (event) => ERR_EVENTS.some((k) => event.includes(k));

// 行拆分：resp= 是 detail 最后一段——之前是请求/结果元数据，之后是响应体；
// 体是 JSON 就缩进格式化（落盘时空白已压平，parse 不受影响），不是就原样。
// 请求行与响应体分开渲染——请求是行，响应也是行，不拼在一起
function splitLine(detail) {
  const i = detail.lastIndexOf("resp=");
  if (i === -1) return { meta: detail, body: "" };
  return { meta: detail.slice(0, i).trimEnd(), body: detail.slice(i + 5).trim() };
}

const FLOWS = ["all", "oauth", "claim", "switch", "gateway", "sys"];

export default function SysLogPage() {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState(null);
  // 自动刷新偏好持久化（与请求日志页同模式）
  const [auto, setAuto] = useState(() => localStorage.getItem("zsys-auto") === "1");
  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    localStorage.setItem("zsys-auto", next ? "1" : "0");
  };
  const [flowFilter, setFlowFilter] = useState("all");
  const [q, setQ] = useState("");

  const reload = () => {
    invoke("syslog_tail", { n: 800 })
      .then((v) => { setEntries(v || []); setErr(null); })
      .catch((e) => setErr(String(e)));
  };
  useEffect(() => { reload(); }, []);
  // 可见性感知轮询：可见 10s / 隐藏 60s，关闸（auto=false）不轮询
  useVisiblePolling(reload, auto ? 10000 : 0, 60000, [auto]);

  // 统一归一：文本行 parseTextLine；请求条目（kind=request，含 req/resp 体）加展开态标记。
  // 归一后统一按时间轴排序（时间戳解析失败排最后）——两类条目来自两个文件，
  // 后端拼装顺序是「先 flowlog 后 gateway」，不排序的话时间轴是错乱的，诊断无从对表
  const parsed = useMemo(() => {
    const norm = (entries || []).map((e) => (e.kind === "request" ? { ...e, ts: e.ts || "" } : parseTextLine(e.line)));
    const tsMs = (p) => {
      const t = p.ts ? Date.parse(p.ts.replace(" ", "T")) : NaN;
      return Number.isFinite(t) ? t : Infinity;
    };
    return norm.sort((a, b) => tsMs(a) - tsMs(b));
  }, [entries]);
  const flows = useMemo(() => {
    const seen = new Set(parsed.map((p) => p.flow ?? (p.kind === "request" ? "gateway" : "")));
    return FLOWS.filter((f) => f === "all" || seen.has(f));
  }, [parsed]);
  const filtered = useMemo(() => {
    let v = parsed;
    if (flowFilter !== "all") v = v.filter((p) => (p.flow ?? (p.kind === "request" ? "gateway" : "")) === flowFilter);
    const needle = q.trim().toLowerCase();
    if (needle) {
      v = v.filter((p) => {
        const hay = p.kind === "request"
          ? `${p.ep ?? ""} ${p.account ?? ""} ${p.model ?? ""} ${p.status ?? ""}`
          : `${p.event} ${p.detail}`;
        return hay.toLowerCase().includes(needle);
      });
    }
    return v;
  }, [parsed, flowFilter, q]);

  const errCount = useMemo(
    () => parsed.filter((p) => p.kind === "text" && isErrEvent(p.event)).length + parsed.filter((p) => p.kind === "request" && p.ok === false).length,
    [parsed],
  );

  const exportLog = () => {
    const body = parsed.map((p) => (p.kind === "request" ? JSON.stringify(p) : p.raw)).join("\n");
    const blob = new Blob([body], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `syslog-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <header className="topbar">
        <div className="wordmark">System<span className="ver"> / {t("sl.title")}</span></div>
      </header>
      <section className="toolbar">
        <button className="btn-ghost has-ic" onClick={reload}><Ic name="refresh" size={15} /> {t("xl.reload")}</button>
        <button className={"tog-inline" + (auto ? " on" : "")} role="switch" aria-checked={auto} onClick={toggleAuto}>
          <span className={"toggle" + (auto ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
          {t("xl.autoRefresh")}
        </button>
        <button className="btn-ghost has-ic" onClick={exportLog}><Ic name="exportAll" size={15} /> {t("xl.export")}</button>
        <span className="tb-spacer" />
      </section>
      <section className="settings open">
        <div className="x-ls-stats">
          <div className="x-ls-group">
            <span className="x-ls-group-label">{t("sl.groupEvents")}</span>
            <div className="x-stat"><span className="x-stat-v">{parsed.length}</span><span className="x-stat-k">{t("xl.total")}</span></div>
            <div className="x-stat"><span className="x-stat-v fail">{errCount}</span><span className="x-stat-k">{t("xl.fail")}</span></div>
          </div>
        </div>
        <div className="x-ls-filters">
          <input className="zcode-path x-ls-search" type="text" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder={t("sl.searchPh")} />
          <select className="zcode-path" value={flowFilter} onChange={(e) => setFlowFilter(e.target.value)}>
            {flows.map((f) => <option key={f} value={f}>{f === "all" ? t("sl.allFlows") : f}</option>)}
          </select>
        </div>
        {err
          ? <div className="dash-empty">{err}</div>
          : filtered.length
            ? <div className="x-log-list">
                {filtered.map((p, i) => p.kind === "request"
                  ? <ReqEntry key={`r${i}`} p={p} />
                  : <TextRow key={`t${i}`} p={p} />)}
              </div>
            : <div className="dash-empty">{t("sl.empty")}</div>}
      </section>
    </>
  );
}

// 文本行折叠：行内单行摘要（sl-detail 由 CSS 单行截断），点击展开分块打全——
// 请求元信息一行、resp 响应体 JSON 缩进格式化，各自独立成块（请求是行，响应也是行），
// 不拼接不做视图切换。hover title 移除——2K 级响应体在气泡里看不了，点击展开才是唯一正确读法
function TextRow({ p }) {
  const [open, setOpen] = useState(false);
  const { meta, body } = splitLine(p.detail || p.raw);
  return (
    <div className={"x-log-item" + (open ? " expanded" : "")}>
      <div className={"x-log-row sl-row clickable" + (isErrEvent(p.event) ? " sl-err" : "")}
        onClick={() => setOpen(!open)}>
        <span className="x-log-ts">{p.ts}</span>
        <span className="sl-flow">[{p.flow}]</span>
        <span className="sl-event">{p.event}</span>
        <span className="sl-detail">{p.detail}</span>
      </div>
      {open
        ? <div className="x-log-detail" onClick={(e) => e.stopPropagation()}>
            {meta ? <pre className="x-log-pre">{meta}</pre> : null}
            {body ? <pre className="x-log-pre">{prettyJson(body)}</pre> : null}
          </div>
        : null}
    </div>
  );
}

// 请求条目折叠行：头行摘要（时间/端点/账号/模型/状态/耗时），点开 LogBlock 展示
// req/resp 原文（原文/JSON/正文/SSE 四视图切换，与请求日志页同一组件）
function ReqEntry({ p }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"x-log-item" + (open ? " expanded" : "")}>
      <div className="x-log-row sl-row clickable" onClick={() => setOpen(!open)}>
        <span className="x-log-ts" title={p.ts ? new Date(p.ts).toLocaleString() : undefined}>{p.ts ? p.ts.slice(0, 19).replace("T", " ") : "—"}</span>
        <span className="sl-flow">[gateway]</span>
        <span className="sl-event">
          <span className={"x-log-method" + (String(p.ep || "").startsWith("GET") ? " get" : "")}>{(p.ep || "").split(" ")[0]}</span>
          {(p.ep || "").split(" ").slice(1).join(" ") || p.ep || "—"}
        </span>
        <span className="sl-detail">
          {p.account ?? "—"} · {p.model ?? "—"} · <span className={p.ok ? "ok" : "fail"}>{p.status ?? "—"}</span>
          {p.ms != null ? ` · ${p.ms}ms` : ""}
          {p.ok === false && p.err ? ` · ${String(p.err).slice(0, 80)}` : ""}
        </span>
      </div>
      {open
        ? <div className="x-log-detail" onClick={(e) => e.stopPropagation()}>
            <div className="x-log-blocks">
              {["req", "resp"].filter((k) => p[k]).map((k) => (
                <LogBlock key={k} resp={k === "resp"} raw={p[k]}
                  label={k === "req" ? `${t("x.logReq")} · ${p.ep || ""}` : `${t("x.logResp")} · ${p.status ?? ""}`} />
              ))}
            </div>
          </div>
        : null}
    </div>
  );
}
