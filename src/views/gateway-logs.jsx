// React 版 Gateway 日志页：gateway.jsonl 全量历史（尾部 2000 行），筛选 + 统计 + 行展开详情。
// 独立成页的原因：网关页已承载端点/协议/模型/池/配置/curl 六块，日志的全量历史、
// 筛选、统计放不下——网关页只留内存环摘要，本页做运维面（筛选/聚合/详情）。
import { useEffect, useMemo, useState } from "react";
import { useVisiblePolling } from "../lib/pageVisible.js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";

// 行视觉辅助：相对时间 / 方法徽章 / 状态与耗时分档着色
const epMethod = (ep) => (ep || "").split(" ")[0].toUpperCase();
const epPath = (ep) => (ep || "").includes(" ") ? (ep || "").split(" ").slice(1).join(" ") : ep || "";
const relTime = (ts) => {
  const d = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(d) || d < 0) return ts;
  const s = Math.floor(d / 1000);
  if (s < 10) return t("xl.justNow");
  if (s < 60) return t("xl.secAgo", { n: s });
  if (s < 3600) return t("xl.minAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("xl.hourAgo", { n: Math.floor(s / 3600) });
  return t("xl.dayAgo", { n: Math.floor(s / 86400) });
};
const msTier = (ms) => (ms == null ? "" : ms < 1000 ? "" : ms < 5000 ? " warn" : " bad");
const stTier = (st) => (st >= 500 ? " bad" : st >= 400 ? " warn" : " ok");
// req/resp 落盘时可能被截断：能解析就美化，不能就原样
const prettyJson = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
// 正文提取：只留人读的回答文本。双协议双通道都认：
// OpenAI（delta.content / message.content / reasoning_content）、Anthropic（delta.text / delta.thinking / content[0].text）。
// 有思考流时前置思考段（max_tokens 截断场景常见「只有思考没有回答」），空结果回退原样不吞内容
const fmtText = (s) => {
  if (!s) return "";
  const t0 = String(s).trim();
  if (t0.startsWith("data:") || t0.includes("\ndata:")) {
    let out = "";
    let think = "";
    for (const line of t0.split("\n")) {
      const d = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!d || d === "[DONE]") continue;
      try {
        const v = JSON.parse(d);
        const ch = v?.choices?.[0];
        out += ch?.delta?.content ?? v?.delta?.text ?? "";
        think += ch?.delta?.reasoning_content ?? v?.delta?.thinking ?? "";
      } catch { /* 非 JSON 帧跳过 */ }
    }
    if (out || think) return (think ? `${t("x.fmtThink")}\n${think}\n\n${t("x.fmtAnswer")}\n` : "") + out;
  }
  try {
    const v = JSON.parse(t0);
    const content = v?.choices?.[0]?.message?.content ?? v?.content?.[0]?.text ?? "";
    const think = v?.choices?.[0]?.message?.reasoning_content ?? "";
    return (think ? `${t("x.fmtThink")}\n${think}\n\n${t("x.fmtAnswer")}\n` : "") + content;
  } catch { return s; }
};

// 请求/响应块：原文 / JSON / 正文 / SSE 四视图切换（req 无正文档；SSE 档把事件流拆成可读行），复制按钮复制当前视图
function LogBlock({ label, raw, resp }) {
  const isJson = useMemo(() => { try { JSON.parse(String(raw).trim()); return true; } catch { return false; } }, [raw]);
  const isSse = useMemo(() => /^\s*event:|^\s*data: /m.test(String(raw)), [raw]);
  // 默认档：能解析就用 JSON，否则落原文
  const [fmt, setFmt] = useState(isJson ? "json" : "raw");
  const opts = [
    ["raw", t("x.fmtRaw")],
    ...(isJson ? [["json", "JSON"]] : []),
    ...(resp ? [["text", t("x.fmtText")]] : []),
    ...(isSse ? [["sse", t("x.fmtSse")]] : []),
  ];
  const view = fmt === "json" ? prettyJson(raw) : fmt === "text" ? fmtText(raw) : fmt === "sse" ? sseFlat(raw) : String(raw);
  return (
    <div className="x-log-block">
      <div className="x-log-block-head">
        <span>{label}</span>
        <span className="x-fmt-seg">
          {opts.map(([k, lab]) => (
            <button key={k} className={fmt === k ? "on" : ""}
              onClick={(e) => { e.stopPropagation(); setFmt(k); }}>{lab}</button>
          ))}
        </span>
        <button className="btn-ghost x-log-copy"
          onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(view).catch(() => {}); }}>
          {t("x.copyBtn")}
        </button>
      </div>
      <pre className={"x-log-pre" + (fmt === "text" ? " x-log-pre-text" : "")}>{view}</pre>
    </div>
  );
}
// SSE 流美化：与原文同一帧序列，只把每帧压缩的 data: JSON 展开成多行（帧间空行），
// event:/[DONE]/非 JSON 行原样保留——就是 SSE 正常格式的可读版，不做任何摘要
const sseFlat = (s) => {
  const out = [];
  for (const l of String(s).split("\n")) {
    const t = l.trimEnd();
    if (t.startsWith("data: ")) {
      const d = t.slice(6).trim();
      if (d !== "[DONE]") {
        try { out.push("data: " + JSON.stringify(JSON.parse(d), null, 2)); continue; } catch { /* 非 JSON 帧原样 */ }
      }
      out.push(t);
    } else if (t) {
      out.push(t);
    }
  }
  return out.join("\n\n");
};

// token 紧凑格式：>=1000 显示 k（一位小数，整 k 去尾），<1000 原样
const fmtTok = (n) => (n >= 1000 ? (n % 1000 === 0 ? `${n / 1000}k` : `${(n / 1000).toFixed(1)}k`) : String(n));
// 成本紧凑格式（USD）：>=1 显示 2 位小数，>=0.01 保留 3 位，更小用科学计数省位；null/0 显示 $0
const fmtCost = (n) => {
  if (!n) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toExponential(1)}`;
};

function LogRow({ l }) {
  const [open, setOpen] = useState(false);
  const hasDetail = l.model != null || l.ms != null || l.err != null || l.attempt != null || l.stream != null;
  return (
    <div className={"x-log-item" + (hasDetail && open ? " expanded" : "")}>
      <div className={"x-log-row" + (hasDetail ? " clickable" : "")} onClick={() => hasDetail && setOpen(!open)}>
        <span className={"x-log-caret" + (hasDetail ? (open ? " open" : "") : " none")}>▸</span>
        <span className="x-log-ts" title={new Date(l.ts).toLocaleString()}>{relTime(l.ts)}</span>
        <span className="x-log-ep">
          <span className={"x-log-method" + (epMethod(l.ep) === "GET" ? " get" : "")}>{epMethod(l.ep)}</span>
          <span className="x-log-path">{epPath(l.ep)}</span>
        </span>
        <span className="x-log-acct" title={l.account}>{l.account ?? "—"}</span>
        <span className="x-log-model">{l.model ?? "—"}</span>
        <span className="x-log-stream">{l.stream != null ? (l.stream ? t("x.stream") : t("x.nonStream")) : "—"}</span>
        <span className={"x-log-code " + (l.ok ? stTier(l.status) : " bad")}>
          <span className="x-log-dot" />{l.status}
        </span>
        <span className={"x-log-ms" + msTier(l.ms)} title={l.ttft != null ? `TTFT ${l.ttft}ms` : undefined}>{l.ms != null ? (l.stream && l.ttft != null ? `${l.ttft}/${l.ms}ms` : `${l.ms}ms`) : "—"}</span>
        <span className="x-log-tok" title={`${t("x.tokOut")} ${l.tout ?? 0} · ${t("x.tokIn")} ${l.tin ?? 0}`}>{(!l.tin && !l.tout) ? "—" : `${fmtTok(l.tout || 0)}↑/${fmtTok(l.tin || 0)}↓`}</span>
        <span className="x-log-cache" title={`${t("x.tokCacheR")} ${l.tcr ?? 0} · ${t("x.tokCacheW")} ${l.tcw ?? 0}`}>{(l.tcr || l.tcw) ? `${fmtTok(l.tcr || 0)}+${fmtTok(l.tcw || 0)}` : "—"}</span>
      </div>
      {hasDetail && open
        ? <div className="x-log-detail" onClick={(e) => e.stopPropagation()}>
            <div className="x-log-meta">
              <div className="x-log-tokens">
                <span className="x-tok"><Ic name="tokIn" size={11} /> {t("x.tokIn")} {l.tin ?? 0}</span>
                <span className="x-tok"><Ic name="tokOut" size={11} /> {t("x.tokOut")} {l.tout ?? 0}</span>
                <span className={"x-tok" + ((l.tcr ?? 0) > 0 ? " hit" : "")}><Ic name="bolt" size={11} /> {t("x.tokCacheR")} {l.tcr ?? 0}</span>
                <span className={"x-tok" + ((l.tcw ?? 0) > 0 ? " hit" : "")}><Ic name="pen" size={11} /> {t("x.tokCacheW")} {l.tcw ?? 0}</span>
                <span className="x-tok"><Ic name="clock" size={11} /> {l.ms != null ? `${l.ms}ms` : "—"}</span>
                {l.ttft != null ? <span className="x-tok" title="TTFT">⚡{l.ttft}ms</span> : null}
                {l.stream && l.tout > 0 && l.ttft != null && l.ms > l.ttft
                  ? <span className="x-tok hit" title="tokens/s（首帧等待不计入）">{Math.round((l.tout / (l.ms - l.ttft)) * 1000)} tok/s</span>
                  : null}
              </div>
              <button className="btn-ghost x-log-copy"
                onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(JSON.stringify(l, null, 2)).catch(() => {}); }}>
                {t("x.copyJson")}
              </button>
            </div>
            <div className="x-log-kv">
              <span className="x-log-k">{t("x.logColModel")}</span><span className="x-log-v">{l.model ?? "—"}{l.stream != null ? ` · ${t(l.stream ? "x.stream" : "x.nonStream")}` : ""}</span>
              <span className="x-log-k">{t("x.logColAcct")}</span><span className="x-log-v">{l.account ?? "—"}</span>
              {l.attempt != null && l.attempt > 0 ? <><span className="x-log-k">{t("x.logAttempt")}</span><span className="x-log-v">{l.attempt + 1}</span></> : null}
              {l.finish ? <><span className="x-log-k">{t("x.logFinish")}</span><span className="x-log-v" title={t("x.logFinishTip")}>{l.finish}</span></> : null}
              {l.ua ? <><span className="x-log-k">UA</span><span className="x-log-v" title={l.ua}>{l.ua}</span></> : null}
              {typeof l.cost === "number" ? <><span className="x-log-k">{t("xl.cost")}</span><span className="x-log-v" title="USD · z.ai 国际站牌价折算">{fmtCost(l.cost)}</span></> : null}
              <span className="x-log-k">{t("x.logColCode")}</span><span className={"x-log-v " + (l.ok ? "ok" : "fail")}>{l.status}{l.req_id ? <small style={{ marginLeft: 6, color: "var(--ink-mute)" }}>{l.req_id.slice(0, 8)}</small> : null}</span>
            </div>
            {l.err ? <div className="x-log-err">{l.err}</div> : null}
            <div className="x-log-blocks">
            {["req", "resp"].filter((k) => l[k]).map((k) => (
              <LogBlock key={k} resp={k === "resp"} raw={l[k]}
                label={k === "req" ? `${t("x.logReq")} · ${l.ep || ""}` : `${t("x.logResp")} · ${l.status ?? ""}`} />
            ))}
            </div>
          </div>
        : null}
    </div>
  );
}

export default function GatewayLogsPage() {
  const [logs, setLogs] = useState(null);
  const [err, setErr] = useState("");
  const [epFilter, setEpFilter] = useState("");
  const [okFilter, setOkFilter] = useState(""); // "" | "ok" | "fail"
  // 聚合维度：按账号（账号级排障：1004/资格类失败谁最集中）/ 按模型
  const [groupDim, setGroupDim] = useState("account");
  // 自由搜索：端点/账号/模型三字段模糊匹配
  const [q, setQ] = useState("");
  // 相对时间保鲜：30s 一次强制重渲染，让「N 秒前」不僵死
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, []);
  // 自动刷新偏好持久化：localStorage（与主题同模式），进页面恢复上次的开关状态
  const [auto, setAuto] = useState(() => localStorage.getItem("zcs-gwlog-auto") === "1");
  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    localStorage.setItem("zcs-gwlog-auto", next ? "1" : "0");
  };
  // 日志落盘开关：真值从网关状态读，切换走 gateway_start 的部分更新（只传 logToDisk）
  const [logDisk, setLogDisk] = useState(null);
  useEffect(() => {
    invoke("gateway_status").then((s) => setLogDisk(s?.logToDisk !== false)).catch(() => {});
  }, []);
  const toggleLogDisk = () => {
    const next = !logDisk;
    setLogDisk(next);
    invoke("gateway_start", { logToDisk: next }).catch(() => setLogDisk(!next));
  };

  const reload = () => {
    invoke("gateway_log_history")
      .then((v) => setLogs(v || []))
      .catch((e) => setErr(String(e)));
  };
  useEffect(() => { reload(); }, []);
  // 自动刷新：可见时 5s 全速轮询 gateway_log_history，托盘/最小化降为 30s 并在
  // 回前台时立即补拉；关闸（auto=false）→ interval 0 = 完全不轮询（hook 语义）
  useVisiblePolling(reload, auto ? 5000 : 0, 30000, [auto]);

  const eps = useMemo(() => [...new Set((logs || []).map((l) => l.ep))].sort(), [logs]);
  const filtered = useMemo(() => {
    let v = logs || [];
    if (epFilter) v = v.filter((l) => l.ep === epFilter);
    if (okFilter === "ok") v = v.filter((l) => l.ok);
    if (okFilter === "fail") v = v.filter((l) => !l.ok);
    const needle = q.trim().toLowerCase();
    if (needle) v = v.filter((l) => `${l.ep} ${l.account ?? ""} ${l.model ?? ""}`.toLowerCase().includes(needle));
    return v;
  }, [logs, epFilter, okFilter, q]);

  const stats = useMemo(() => {
    const v = filtered;
    const ok = v.filter((l) => l.ok).length;
    // 延迟口径：分位数而非均值（业界惯例，均值被长尾拉偏）；TTFT 仅统计流式行
    const mss = v.map((l) => l.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
    const ttfts = v.filter((l) => l.stream && typeof l.ttft === "number").map((l) => l.ttft).sort((a, b) => a - b);
    const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
    const sum = (k) => v.reduce((a, l) => a + (l[k] || 0), 0);
    return {
      total: v.length, ok, fail: v.length - ok,
      rate: v.length ? Math.round((ok / v.length) * 100) : null,
      msP50: pct(mss, 0.5), msP95: pct(mss, 0.95),
      ttftP50: pct(ttfts, 0.5), ttftP95: pct(ttfts, 0.95),
      tin: sum("tin"), tout: sum("tout"), tcache: sum("tcr") + sum("tcw"),
      cost: v.reduce((a, l) => a + (typeof l.cost === "number" ? l.cost : 0), 0),
    };
  }, [filtered]);

  // 分组聚合：复用当前筛选结果，按维度归组算成功率/分位数/token 汇总，按请求量降序
  const groups = useMemo(() => {
    const map = new Map();
    for (const l of filtered) {
      const k = l[groupDim] ?? "—";
      let g = map.get(k);
      if (!g) { g = { key: k, n: 0, ok: 0, mss: [], ttfts: [], tin: 0, tout: 0, tcache: 0 }; map.set(k, g); }
      g.n += 1;
      if (l.ok) g.ok += 1;
      if (typeof l.ms === "number") g.mss.push(l.ms);
      if (l.stream && typeof l.ttft === "number") g.ttfts.push(l.ttft);
      g.tin += l.tin || 0; g.tout += l.tout || 0; g.tcache += (l.tcr || 0) + (l.tcw || 0);
    }
    const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
    return [...map.values()]
      .map((g) => {
        g.mss.sort((a, b) => a - b);
        g.ttfts.sort((a, b) => a - b);
        return { ...g, rate: g.n ? Math.round((g.ok / g.n) * 100) : null, p50: pct(g.mss, 0.5), p95: pct(g.mss, 0.95), tp50: pct(g.ttfts, 0.5) };
      })
      .sort((a, b) => b.n - a.n);
  }, [filtered, groupDim]);
  const exportLogs = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gateway-logs-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <header className="topbar">
        <div className="wordmark">Gateway<span className="ver"> / {t("xl.title")}</span></div>
      </header>
      <section className="toolbar">
        <button className="btn-ghost has-ic" onClick={reload}><Ic name="refresh" size={15} /> {t("xl.reload")}</button>
        <button className={"tog-inline" + (auto ? " on" : "")} role="switch" aria-checked={auto}
          onClick={toggleAuto}>
          <span className={"toggle" + (auto ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
          {t("xl.autoRefresh")}
        </button>
        <button className={"tog-inline" + (logDisk ? " on" : "")} role="switch" aria-checked={!!logDisk}
          disabled={logDisk == null} onClick={toggleLogDisk}>
          <span className={"toggle" + (logDisk ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
          {t("x.tuneLogDisk")}
        </button>
        <button className="btn-ghost has-ic" onClick={exportLogs}><Ic name="exportAll" size={15} /> {t("xl.export")}</button>
        <span className="tb-spacer" />
      </section>
      <section className="settings open">
        <div className="x-ls-stats">
          <div className="x-ls-group">
            <span className="x-ls-group-label">{t("xl.groupReq")}</span>
            <div className="x-stat"><span className="x-stat-v">{stats.total}</span><span className="x-stat-k">{t("xl.total")}</span></div>
            <div className="x-stat"><span className="x-stat-v ok">{stats.ok}</span><span className="x-stat-k">{t("xl.ok")}</span></div>
            <div className="x-stat"><span className="x-stat-v fail">{stats.fail}</span><span className="x-stat-k">{t("xl.fail")}</span></div>
            {stats.rate != null
              ? <div className="x-stat"><span className="x-stat-v">{stats.rate}<small>%</small></span><span className="x-stat-k">{t("xl.rate")}</span></div>
              : null}
          </div>
          {stats.msP50 != null || stats.ttftP50 != null
            ? <div className="x-ls-group">
                <span className="x-ls-group-label">{t("xl.groupLat")}</span>
                {stats.msP50 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.msP50}<small>ms</small></span><span className="x-stat-k" title={t("xl.latTotal")}>p50</span></div>
                  : null}
                {stats.msP95 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.msP95}<small>ms</small></span><span className="x-stat-k" title={t("xl.latTotal")}>p95</span></div>
                  : null}
                {stats.ttftP50 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.ttftP50}<small>ms</small></span><span className="x-stat-k" title="Time To First Token (stream, p50)">TTFT p50</span></div>
                  : null}
                {stats.ttftP95 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.ttftP95}<small>ms</small></span><span className="x-stat-k" title="Time To First Token (stream, p95)">TTFT p95</span></div>
                  : null}
              </div>
            : null}
          <div className="x-ls-group">
            <span className="x-ls-group-label">{t("xl.groupTok")}</span>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tin)}<small>↓</small></span><span className="x-stat-k">{t("x.tokIn")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tout)}<small>↑</small></span><span className="x-stat-k">{t("x.tokOut")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tcache)}<small>⚡</small></span><span className="x-stat-k">{t("x.tokCache")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtCost(stats.cost)}<small>$</small></span><span className="x-stat-k">{t("xl.cost")}</span></div>
          </div>
        </div>

        <div className="x-ls-filters">
          <input className="zcode-path x-ls-search" type="text" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder={t("xl.searchPh")} />
          <select className="zcode-path" value={epFilter} onChange={(e) => setEpFilter(e.target.value)}>
            <option value="">{t("xl.allEps")}</option>
            {eps.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select className="zcode-path" value={okFilter} onChange={(e) => setOkFilter(e.target.value)}>
            <option value="">{t("xl.allStatus")}</option>
            <option value="ok">{t("xl.ok")}</option>
            <option value="fail">{t("xl.fail")}</option>
          </select>
          <div className="lang-seg x-ls-dimseg">
            <button className={"lang-opt" + (groupDim === "account" ? " on" : "")} onClick={() => setGroupDim("account")}>{t("xl.byAccount")}</button>
            <button className={"lang-opt" + (groupDim === "model" ? " on" : "")} onClick={() => setGroupDim("model")}>{t("xl.byModel")}</button>
          </div>
        </div>

        {filtered.length
          ? <div className="x-ls-agg">
              <div className="x-ls-agg-row head">
                <span className="x-ls-agg-name">{groupDim === "account" ? t("x.logColAcct") : t("x.logColModel")}</span>
                <span className="x-ls-agg-v">{t("xl.total")}</span>
                <span className="x-ls-agg-v">{t("xl.rate")}</span>
                <span className="x-ls-agg-v" title={t("xl.latTotal")}>p50</span>
                <span className="x-ls-agg-v" title={t("xl.latTotal")}>p95</span>
                <span className="x-ls-agg-v" title="Time To First Token (stream, p50)">TTFT p50</span>
                <span className="x-ls-agg-v">{t("x.tokIn")}</span>
                <span className="x-ls-agg-v">{t("x.tokOut")}</span>
                <span className="x-ls-agg-v">{t("x.tokCache")}</span>
              </div>
              {groups.map((g) => (
                <div key={g.key} className="x-ls-agg-row">
                  <span className="x-ls-agg-name" title={g.key}>{g.key}</span>
                  <span className="x-ls-agg-v">{g.n}</span>
                  <span className={"x-ls-agg-v" + (g.rate != null ? (g.rate >= 90 ? " ok" : g.rate < 60 ? " bad" : "") : "")}>{g.rate != null ? `${g.rate}%` : "—"}</span>
                  <span className="x-ls-agg-v">{g.p50 != null ? `${g.p50}ms` : "—"}</span>
                  <span className="x-ls-agg-v">{g.p95 != null ? `${g.p95}ms` : "—"}</span>
                  <span className="x-ls-agg-v">{g.tp50 != null ? `${g.tp50}ms` : "—"}</span>
                  <span className="x-ls-agg-v">{fmtTok(g.tin)}↓</span>
                  <span className="x-ls-agg-v">{fmtTok(g.tout)}↑</span>
                  <span className="x-ls-agg-v">{fmtTok(g.tcache)}⚡</span>
                </div>
              ))}
            </div>
          : null}

        {err
          ? <div className="hint" style={{ color: "var(--red)" }}>{err}</div>
          : filtered.length
            ? <div className="x-log-list">
                <div className="x-log-head">
                  <span></span>
                  <span>{t("x.logColTs")}</span>
                  <span>{t("x.logColEp")}</span>
                  <span>{t("x.logColAcct")}</span>
                  <span>{t("x.logColModel")}</span>
                  <span>{t("x.logColStream")}</span>
                  <span>{t("x.logColCode")}</span>
                  <span>{t("x.logColMs")}</span>
                  <span>{t("x.logColTok")}</span>
                  <span>{t("x.logColCache")}</span>
                </div>
                {filtered.slice().reverse().map((l) => <LogRow key={`${l.ts}|${l.ep}|${l.account}`} l={l} />)}
              </div>
            : <div className="x-log-empty">
                <Ic name="empty" size={18} />
                <span>{t("xl.empty")}</span>
              </div>}
        <div className="hint">{t("xl.hint")}</div>
      </section>
    </>
  );
}
