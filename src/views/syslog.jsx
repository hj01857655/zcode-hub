// SysLog 页 — 系统日志：flowlog 尾部行（oauth/claim/switch/gateway/sys 五个流的运维事件）。
// 骨架复用请求日志页（topbar/toolbar/x-log-list），数据源 syslog_tail 命令；
// 行格式 `ts [flow] event detail`，按 [flow] 分组过滤、error 类事件着色。
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { useVisiblePolling } from "../lib/pageVisible.js";

// 行解析：`2026-11-07 12:00:00 [flow] event detail...`
// 解析失败的行按 raw 展示（不静默吞）——日志格式是给程序读的，出现意外行本身就是要看到的事
function parseLine(line) {
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

const FLOWS = ["all", "oauth", "claim", "switch", "gateway", "sys"];

export default function SysLogPage() {
  const [lines, setLines] = useState(null);
  const [err, setErr] = useState(null);
  // 自动刷新偏好持久化（与请求日志页同模式）
  const [auto, setAuto] = useState(() => localStorage.getItem("zsys-auto") === "1");
  const [flowFilter, setFlowFilter] = useState("all");
  const [q, setQ] = useState("");

  const reload = () => {
    invoke("syslog_tail", { n: 800 })
      .then((v) => { setLines(v || []); setErr(null); })
      .catch((e) => setErr(String(e)));
  };
  useEffect(() => { reload(); }, []);
  // 可见性感知轮询：可见 10s / 隐藏 60s，关闸（auto=false）不轮询
  useVisiblePolling(reload, auto ? 10000 : 0, 60000, [auto]);

  const parsed = useMemo(() => (lines || []).map(parseLine), [lines]);
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

  const errCount = useMemo(() => parsed.filter((p) => isErrEvent(p.event)).length, [parsed]);

  const exportLog = () => {
    const blob = new Blob([parsed.map((p) => p.raw).join("\n")], { type: "text/plain" });
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
                {filtered.map((p, i) => (
                  <div key={i} className={"x-log-row sl-row" + (isErrEvent(p.event) ? " sl-err" : "")}
                    title={p.raw}>
                    <span className="x-log-ts">{p.ts}</span>
                    <span className="sl-flow">[{p.flow}]</span>
                    <span className="sl-event">{p.event}</span>
                    <span className="sl-detail" title={p.detail}>{p.detail}</span>
                  </div>
                ))}
              </div>
            : <div className="dash-empty">{t("sl.empty")}</div>}
      </section>
    </>
  );
}
