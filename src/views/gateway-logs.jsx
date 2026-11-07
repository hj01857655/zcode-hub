// React 版 Gateway 日志页：gateway.jsonl 全量历史（尾部 2000 行），筛选 + 统计 + 行展开详情。
// 独立成页的原因：网关页已承载端点/协议/模型/池/配置/curl 六块，日志的全量历史、
// 筛选、统计放不下——网关页只留内存环摘要，本页做运维面（筛选/聚合/详情）。
import { useEffect, useMemo, useState } from "react";
import { useVisiblePolling } from "../lib/pageVisible.js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";
import { LogBlock } from "../components/LogBlock.jsx";

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

// token 紧凑格式：>=1000 显示 k（一位小数，整 k 去尾），<1000 原样
const fmtTok = (n) => (n >= 1000 ? (n % 1000 === 0 ? `${n / 1000}k` : `${(n / 1000).toFixed(1)}k`) : String(n));
// 成本紧凑格式（USD）：>=1 显示 2 位小数，>=0.01 保留 3 位，更小用科学计数省位；null/0 显示 $0
const fmtCost = (n) => {
  if (!n) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toExponential(1)}`;
};

function LogRow({ l, open, onToggle }) {
  const hasDetail = l.model != null || l.ms != null || l.err != null || l.attempt != null || l.stream != null;
  return (
    <div className={"x-log-item" + (hasDetail && open ? " expanded" : "")}>
      <div className={"x-log-row" + (hasDetail ? " clickable" : "")} onClick={() => hasDetail && onToggle()}>
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
                  ? <span className="x-tok hit" title={t("xl.tokRateTip")}>{Math.round((l.tout / (l.ms - l.ttft)) * 1000)} tok/s</span>
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
              {typeof l.cost === "number" ? <><span className="x-log-k">{t("xl.cost")}</span><span className="x-log-v" title={t("xl.costTip")}>{fmtCost(l.cost)}</span></> : null}
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
  // 时间范围："" | "1h" | "6h" | "today"（"" = 全部，日志文件本身有 2000 行容量上限）
  const [rangeFilter, setRangeFilter] = useState("");
  // 聚合维度：按账号（账号级排障：1004/资格类失败谁最集中）/ 按模型
  const [groupDim, setGroupDim] = useState("account");
  // 自由搜索：端点/账号/模型三字段模糊匹配
  const [q, setQ] = useState("");
  // 明细行展开互斥：openKey 为当前展开行的唯一键，点开新行自动收旧行
  const [openKey, setOpenKey] = useState(null);
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
    // 时间范围前置过滤（"" = 全部）：1h/6h 按 ts 差值，today 按本地日界
    if (rangeFilter) {
      const now = Date.now();
      const todayStr = new Date().toDateString();
      v = v.filter((l) => {
        const t = new Date(l.ts).getTime();
        if (!Number.isFinite(t)) return false;
        if (rangeFilter === "today") return new Date(t).toDateString() === todayStr;
        return now - t <= (rangeFilter === "1h" ? 3600e3 : 6 * 3600e3);
      });
    }
    if (epFilter) v = v.filter((l) => l.ep === epFilter);
    if (okFilter === "ok") v = v.filter((l) => l.ok);
    if (okFilter === "fail") v = v.filter((l) => !l.ok);
    const needle = q.trim().toLowerCase();
    if (needle) v = v.filter((l) => `${l.ep} ${l.account ?? ""} ${l.model ?? ""}`.toLowerCase().includes(needle));
    return v;
  }, [logs, epFilter, okFilter, q, rangeFilter]);

  const stats = useMemo(() => {
    const v = filtered;
    const ok = v.filter((l) => l.ok).length;
    // 延迟口径：分位数而非均值（业界惯例，均值被长尾拉偏）；TTFT 仅统计流式行
    const mss = v.map((l) => l.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
    const ttfts = v.filter((l) => l.stream && typeof l.ttft === "number").map((l) => l.ttft).sort((a, b) => a - b);
    const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
    const sum = (k) => v.reduce((a, l) => a + (l[k] || 0), 0);
    // 错误码 Top3（徽章用）：失败行按「body 业务码 → HTTP 状态码」取键计数，
    // 与聚合表 errDist 同源；点击徽章把码写进搜索框下钻
    const errs = {};
    for (const l of v) {
      if (l.ok) continue;
      const biz = String(l.err || "").match(/"code"\s*:\s*(\d{3,4})/)?.[1];
      const ekey = biz ? `${biz}` : String(l.status ?? "?");
      errs[ekey] = (errs[ekey] || 0) + 1;
    }
    const errTop = Object.entries(errs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, n]) => ({ code, n }));
    return {
      total: v.length, ok, fail: v.length - ok,
      rate: v.length ? Math.round((ok / v.length) * 100) : null,
      msP50: pct(mss, 0.5), msP95: pct(mss, 0.95),
      ttftP50: pct(ttfts, 0.5), ttftP95: pct(ttfts, 0.95),
      tin: sum("tin"), tout: sum("tout"), tcache: sum("tcr") + sum("tcw"),
      errTop,
    };
  }, [filtered]);

  // 分组聚合：复用当前筛选结果，按维度归组算成功率/分位数/token 汇总，按请求量降序
  const groups = useMemo(() => {
    const map = new Map();
    for (const l of filtered) {
      const k = l[groupDim] ?? "—";
      let g = map.get(k);
      if (!g) { g = { key: k, n: 0, ok: 0, mss: [], ttfts: [], tin: 0, tout: 0, tcache: 0, errs: {}, rows: [] }; map.set(k, g); }
      g.n += 1;
      if (l.ok) g.ok += 1;
      if (typeof l.ms === "number") g.mss.push(l.ms);
      if (l.stream && typeof l.ttft === "number") g.ttfts.push(l.ttft);
      g.tin += l.tin || 0; g.tout += l.tout || 0; g.tcache += (l.tcr || 0) + (l.tcw || 0);
      // 折叠树：组内明细行数组（时间倒序，与原明细表渲染顺序一致）
      g.rows.push(l);
      // 错误分布聚合：失败行按「HTTP 状态码 → body 业务码」二级取键。
      // l.err 是上游 body 截 200 字符（JSON 时含 "code":3012 之类），正则提取业务码；
      // 提不出就只记状态码——429×N / 3012×N / 504×N 的分布一眼可见
      if (!l.ok) {
        const biz = String(l.err || "").match(/"code"\s*:\s*(\d{3,4})/)?.[1];
        const ekey = biz ? `${biz}` : String(l.status ?? "?");
        g.errs[ekey] = (g.errs[ekey] || 0) + 1;
      }
    }
    const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
    const errSummary = (errs) => Object.entries(errs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, n]) => `${code}×${n}`)
      .join(" · ");
    const rows = [...map.values()].map((g) => {
      g.mss.sort((a, b) => a - b);
      g.ttfts.sort((a, b) => a - b);
      return { ...g, errTop: errSummary(g.errs), rate: g.n ? Math.round((g.ok / g.n) * 100) : null, p50: pct(g.mss, 0.5), p95: pct(g.mss, 0.95), tp50: pct(g.ttfts, 0.5) };
    });
    // 迷你条形基准：全表最大 p95（有数值的行），无 p95 的组不画
    const maxP95 = Math.max(0, ...rows.map((g) => g.p95 ?? 0));
    return rows
      .map((g) => ({ ...g, p95Bar: g.p95 != null && maxP95 > 0 ? g.p95 / maxP95 : null }))
      // 诊断排序：失败率高的组置顶（失败率主排序，请求量次排序）——账号多时
      // 出问题的组不再被请求量大的健康组淹没；全成功时自然退化为按量排
      .sort((a, b) => {
        const fa = a.rate != null ? 100 - a.rate : -1;
        const fb = b.rate != null ? 100 - b.rate : -1;
        return (fb - fa) || (b.n - a.n);
      });
  }, [filtered, groupDim]);
  // 折叠树展开态：Set<组键>，组节点点击切换展开/收起；换维度或筛选重算时自动全收
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  useEffect(() => { setExpandedGroups(new Set()); }, [filtered, groupDim]);
  const toggleGroup = (key) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
        <div className="wordmark">Request<span className="ver"> / {t("xl.title")}</span></div>
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
                  ? <div className="x-stat"><span className="x-stat-v">{stats.ttftP50}<small>ms</small></span><span className="x-stat-k" title={t("xl.ttftTip")}>TTFT p50</span></div>
                  : null}
                {stats.ttftP95 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.ttftP95}<small>ms</small></span><span className="x-stat-k" title={t("xl.ttftTip")}>TTFT p95</span></div>
                  : null}
              </div>
            : null}
          <div className="x-ls-group">
            <span className="x-ls-group-label">{t("xl.groupTok")}</span>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tin)}<small>↓</small></span><span className="x-stat-k">{t("x.tokIn")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tout)}<small>↑</small></span><span className="x-stat-k">{t("x.tokOut")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tcache)}<small>⚡</small></span><span className="x-stat-k">{t("x.tokCache")}</span></div>
            {stats.errTop.map(({ code, n }) => (
              <div key={code} className="x-stat err-badge" title={t("xl.errDistTip")}
                role="button" style={{ cursor: "pointer" }}
                onClick={() => setQ(code)}>
                <span className="x-stat-v fail">{n}</span>
                <span className="x-stat-k">{code}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="x-ls-filters">
          <input className="zcode-path x-ls-search" type="text" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder={t("xl.searchPh")} />
          <select className="zcode-path" value={rangeFilter} onChange={(e) => setRangeFilter(e.target.value)}>
            <option value="">{t("xl.rangeAll")}</option>
            <option value="1h">{t("xl.range1h")}</option>
            <option value="6h">{t("xl.range6h")}</option>
            <option value="today">{t("xl.rangeToday")}</option>
          </select>
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
          ? <div className="x-log-list tree">
              <div className="x-log-head">
                <span></span>
                <span>{groupDim === "account" ? t("x.logColAcct") : t("x.logColModel")}</span>
                <span>{t("xl.total")}</span>
                <span>{t("xl.rate")}</span>
                <span></span>
                <span title={t("xl.latTotal")}>p50</span>
                <span title={t("xl.latTotal")}>p95</span>
                <span title={t("xl.ttftTip")}>TTFT p50</span>
                <span title={t("xl.tokInOut")}>{t("xl.tokInOut")}</span>
                <span title={t("xl.errDistTip")}>{t("xl.errDist")}</span>
              </div>
              {groups.map((g) => {
                const failed = g.rate != null && g.rate < 100;
                const expanded = expandedGroups.has(g.key);
                return (
                <div key={g.key} className={"x-log-item" + (expanded ? " expanded" : "")}>
                  {/* 组节点行：点击展开/收起该组明细 */}
                  <div className={"x-log-row tree-group" + (failed ? " has-fail" : "")}
                    onClick={() => toggleGroup(g.key)} role="button">
                    <span className={"x-log-caret" + (expanded ? " open" : "")}>▸</span>
                    <span className="x-log-ts" title={`${g.key} · ${t("xl.groupTip")}`}>
                      <span className="tree-group-name">{g.key}</span>
                    </span>
                    <span className="x-log-acct">{g.n} 条 · {g.errTop || t("xl.allOk")}</span>
                    <span className="x-log-model">{g.rate != null ? `${g.rate}%` : "—"}</span>
                    <span className={"x-log-stream" + (failed ? " " : " ok")}>&nbsp;</span>
                    <span className="x-log-code"><span className="x-log-dot" />{g.p50 != null ? `${g.p50}ms` : "—"}</span>
                    <span className={"x-log-ms" + (g.p95 != null && g.p95 >= 5000 ? " bad" : g.p95 != null && g.p95 >= 1000 ? " warn" : "")}>
                      {g.p95 != null ? `${g.p95}ms` : "—"}
                    </span>
                    <span className="x-log-tok">{g.tp50 != null ? `${g.tp50}ms` : "—"}</span>
                    <span className="x-log-cache">{fmtTok(g.tin)}↓/{fmtTok(g.tout)}↑</span>
                    <span className="x-ls-agg-errdist" title={g.errTop || undefined}>{failed ? (g.errTop || "—") : ""}</span>
                  </div>
                  {/* 组内明细：懒渲染——仅展开的组渲染 LogRow（体大，收起的组零 DOM） */}
                  {expanded
                    ? <div className="tree-rows">
                        {g.rows.slice().reverse().map((l) => {
                          const key = `${l.ts}|${l.ep}|${l.account}`;
                          return <LogRow key={key} l={l} open={openKey === key} onToggle={() => setOpenKey(openKey === key ? null : key)} />;
                        })}
                      </div>
                    : null}
                </div>
                );
              })}
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
