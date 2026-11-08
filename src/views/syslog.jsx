// SysLog 页 — 系统日志：flowlog 尾部行（oauth/claim/switch/gateway/sys 五个流的运维事件，
// 含 httplog 中间件自动记录的全部 zcode 上游接口调用摘要）。网关转发请求不在此——
// 那是请求日志页的职责。视觉是纯文本日志流（.sl-line 连续文本行，无网格无统计卡），
// 工具条/过滤/搜索复用请求日志页样式；数据源 syslog_tail 命令；
// 行格式 `ts [flow] event detail`，按 [flow] 分组过滤、error 类事件整行标红。
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";
import { prettyJson } from "../components/LogBlock.jsx";
import { useVisiblePolling } from "../lib/pageVisible.js";

// 行解析（flowlog 文本行）：`2026-11-07 12:00:00 [flow] event detail...`
// 解析失败的行按 raw 展示（不静默吞）——日志格式是给程序读的，出现意外行本身就是要看到的事
function parseTextLine(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([^\]]+)\] ?(.*)$/);
  if (!m) return { raw: line, ts: "", flow: "raw", event: line, detail: "" };
  const [, ts, flow, rest] = m;
  const sp = rest.indexOf(" ");
  const event = sp === -1 ? rest : rest.slice(0, sp);
  const detail = sp === -1 ? "" : rest.slice(sp + 1);
  return { raw: line, ts, flow, event, detail };
}

// 错误类事件名（着色与级别过滤的依据）：按事件名后缀/关键词判定
const ERR_EVENTS = ["fail", "error", "timeout", "corrupt", "downgraded"];
const isErrEvent = (event) => ERR_EVENTS.some((k) => event.includes(k));

// 行拆分：req=/resp= 是 detail 尾部锚点——http-req 行以 req= 收尾、中间件结果行
// 以 resp= 收尾，各自把行切成「元信息 + JSON 体」两段；体是 JSON 就缩进格式化
// （落盘时空白已压平，parse 不受影响），不是就原样。请求行与响应体分开渲染。
// 两个锚点长度不同（req= 4 字符、resp= 5），偏移各按锚点算——统一 +5 会把 req=
// 行的体首字符（{）切掉，prettyJson 解析失败退化原文（存量 bug，11-08 修）。
// 已知边界：体内容里再出现 req=/resp= 字样时 lastIndexOf 切错位，只影响展开视图
// 的归属显示，不丢行不崩溃
function splitLine(detail) {
  const iR = detail.lastIndexOf("resp=");
  const iQ = detail.lastIndexOf("req=");
  if (iQ > iR) return { meta: detail.slice(0, iQ).trimEnd(), body: detail.slice(iQ + 4).trim() };
  if (iR !== -1) return { meta: detail.slice(0, iR).trimEnd(), body: detail.slice(iR + 5).trim() };
  return { meta: detail, body: "" };
}

const FLOWS = ["all", "oauth", "claim", "switch", "gateway", "sys"];

// HTTP 行 meta 结构化：结果行「{method} {url} → {status} ms={n}」、请求行「{method} {url}」。
// 命中则行内徽标化（method 徽标、host 弱化、path 亮、状态分色、耗时弱化），未命中
//（touch-fail / cred-cooldown 等业务行）回退纯文本 sl-detail。行格式不变，纯展示层。
const HTTP_RESULT_RE = /^([A-Z]+) (\S+) → (\d+) ms=(\d+)$/;
const HTTP_REQ_RE = /^([A-Z]+) (\S+)$/;

function splitUrl(u) {
  const i = u.indexOf("/");
  return i === -1 ? { host: u, path: "" } : { host: u, path: u.slice(i) };
}

function statusCls(status) {
  if (status === 0 || status >= 500) return "fail";
  if (status >= 400) return "warn";
  return "ok";
}

function HttpMeta({ meta }) {
  const m = meta.match(HTTP_RESULT_RE);
  if (m) {
    const [, method, url, status, ms] = m;
    const { host, path } = splitUrl(url);
    return (
      <span className="sl-http">
        {" "}<span className={"x-log-method" + (method === "GET" ? " get" : "")}>{method}</span>
        {" "}<span className="sl-host">{host}</span><span className="sl-path">{path}</span>
        {" "}<span className="sl-arrow">→</span>
        {" "}<span className={"sl-status " + statusCls(+status)}>{status}</span>
        <span className="sl-ms"> · {ms}ms</span>
      </span>
    );
  }
  const r = meta.match(HTTP_REQ_RE);
  if (r) {
    const [, method, url] = r;
    const { host, path } = splitUrl(url);
    return (
      <span className="sl-http">
        {" "}<span className={"x-log-method" + (method === "GET" ? " get" : "")}>{method}</span>
        {" "}<span className="sl-host">{host}</span><span className="sl-path">{path}</span>
        {" "}<span className="sl-reqtag">req</span>
      </span>
    );
  }
  return null;
}

export default function SysLogPage() {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState(null);
  // 自动刷新偏好持久化：默认开，显式关过才默认关（关闸时不轮询）
  const [auto, setAuto] = useState(() => localStorage.getItem("zsys-auto") !== "0");
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

  // 统一归一：全部为文本行（后端已回归 flowlog 单源），按时间轴排序
  const parsed = useMemo(() => {
    const norm = (entries || []).map(parseTextLine);
    const tsMs = (p) => {
      const t = p.ts ? Date.parse(p.ts.replace(" ", "T")) : NaN;
      return Number.isFinite(t) ? t : Infinity;
    };
    return norm.sort((a, b) => tsMs(a) - tsMs(b));
  }, [entries]);
  const flows = useMemo(() => {
    const seen = new Set(parsed.map((p) => p.flow));
    return FLOWS.filter((f) => f === "all" || seen.has(f));
  }, [parsed]);
  const filtered = useMemo(() => {
    let v = parsed;
    if (flowFilter !== "all") v = v.filter((p) => p.flow === flowFilter);
    const needle = q.trim().toLowerCase();
    if (needle) v = v.filter((p) => `${p.event} ${p.detail}`.toLowerCase().includes(needle));
    return v;
  }, [parsed, flowFilter, q]);

  const exportLog = () => {
    const body = parsed.map((p) => p.raw).join("\n");
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
                {filtered.map((p, i) => <TextRow key={`t${i}`} p={p} />)}
              </div>
            : <div className="dash-empty">{t("sl.empty")}</div>}
      </section>
    </>
  );
}

// 文本行 = 日志本体：无网格无列对齐，一行就是一条连续日志文本（ts [flow] event detail），
// 错误行整体标红。默认单行省略，点击展开分块打全——meta 一行、resp 响应体 JSON 缩进
// 格式化，各自独立成块；2K 级响应体只在展开视图读，列表保持日志流的滚动密度。
// hover title 移除——2K 级响应体在气泡里看不了，点击展开才是唯一正确读法
// 有选区时不触发展开——拖选文本松开鼠标的 click 事件不能与「点击展开/收起」互相打架，
// 纯点击（无选中文字）才 toggle
const clickNoSelect = (fn) => (e) => {
  if (window.getSelection()?.toString()) return;
  fn(e);
};

function TextRow({ p }) {
  const [open, setOpen] = useState(false);
  const { meta, body } = splitLine(p.detail || p.raw);

  // 单行视图：HTTP 行结构化渲染 + body 弱色全文（视觉溢出由 .sl-line 的 ellipsis
  // 收掉，DOM 不截——复制/搜索拿得到全文）；非 HTTP 行回退 sl-detail 原文。
  // React 元素不能 String() 转——展开视图 meta 也走组件渲染（曾写成
  // String(structuredMeta)，产物是 "[object Object]"，11-08 修）
  const structuredMeta = HttpMeta({ meta });

  return (
    <div className={"x-log-item" + (open ? " expanded" : "")}>
      <div className={"sl-line clickable" + (isErrEvent(p.event) ? " sl-err" : "")}
        onClick={clickNoSelect(() => setOpen(!open))}>
        <span className="x-log-ts">{p.ts}</span>
        {" "}<span className="sl-flow">[{p.flow}]</span>
        {" "}<span className="sl-event">{p.event}</span>
        {structuredMeta || <span className="sl-detail">{p.detail}</span>}
        {body ? <span className="sl-body">{body}</span> : null}
      </div>
      {open
        ? <div className="x-log-detail" onClick={(e) => e.stopPropagation()}>
            {/* meta 块：HTTP 行结构化（同单行），业务行纯文本 */}
            {meta
              ? <div className="x-log-pre">{structuredMeta || meta}</div>
              : null}
            {body ? <pre className="x-log-pre">{prettyJson(body)}</pre> : null}
          </div>
        : null}
    </div>
  );
}
