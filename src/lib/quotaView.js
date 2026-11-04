// quotaView.js — 额度展示的纯计算层（原 main.js 里的 *Html 函数抽成数据）
import { t, has, lang } from "./i18n.js";

export function fmtTokens(n) {
  if (n == null) return "";
  if (lang() === "zh") {
    if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 1) + "亿";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
  }
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(Math.round(n));
}

export function itemKind(it) {
  if (it.kind) return it.kind;
  if (it.name.includes("提示次数")) return "prompt_count";
  if (it.name.includes("使用时长")) return "duration";
  return "raw";
}

export function windowLabel(it) {
  if (it.window) {
    if (it.window.startsWith("hours:")) return t("q.win.hours", { n: it.window.slice(6) });
    return has(`q.win.${it.window}`) ? t(`q.win.${it.window}`) : it.window;
  }
  const m = it.name.match(/[（(]每\s*([^）)]+)[）)]/);
  if (m) return "每" + m[1].replace(/^每/, "");
  if (itemKind(it) === "duration") return t("q.monthlyShort");
  if (itemKind(it) === "prompt_count") return t("q.countShort");
  return it.name;
}

export function resetLabel(it) {
  if (it.reset) return t("q.resets", { time: it.reset });
  return it.period_end || "";
}

// 仅剃「GLM-数字」形态前缀（GLM-5.3 → 5.3），别名模型（GLM-5.3-Flash）保留全名
export function balLabel(name) {
  return /^[Gg][Ll][Mm]-?\d/.test(name) ? name.replace(/^[Gg][Ll][Mm]-?/i, "") : name;
}

// 短窗口（起止 ≤48h）滚动批次免告警，展示精确到时刻
export function expireInfo(s, starts) {
  if (!s) return null;
  const hasTime = s.length >= 16;
  const ms = new Date(hasTime ? s.replace(" ", "T") : s + "T23:59:59") - Date.now();
  if (isNaN(ms)) return { text: s, soon: false, warn: false };
  let shortWindow = false;
  if (starts) {
    const startMs = new Date(String(starts).replace(" ", "T")).getTime();
    if (!isNaN(startMs) && ms >= startMs - Date.now() && ms - (startMs - Date.now()) <= 48 * 3600000) {
      shortWindow = true;
    }
  }
  const soon = !shortWindow && ms <= 5 * 86400000;
  const warn = !shortWindow && ms <= 7 * 86400000;
  return { text: (soon || shortWindow) && hasTime ? s : s.slice(0, 10), soon, warn };
}

export function tierChipOf(tier, code) {
  const c = String(code || "").toLowerCase();
  const s = String(tier || "").toLowerCase();
  if (c === "max" || (!c && s.includes("max"))) return { label: "Max", cls: "max" };
  if (c === "pro" || (!c && s.includes("pro"))) return { label: "Pro", cls: "pro" };
  if (c === "lite" || (!c && s.includes("lite"))) return { label: "Lite", cls: "lite" };
  if (c === "start") return { label: "Start", cls: "trial" };
  if (c === "trial" || (!c && (s.includes("trial") || String(tier || "").includes("体验")))) {
    return { label: t("q.trial"), cls: "trial" };
  }
  return { label: tier, cls: "other" };
}

// 账号行徽章：按档去重（鸡蛋与常驻套餐同为 start 时不出双徽章），至多两档
export function tierBadges(data) {
  if (!data) return [];
  const plans = data.plans || [];
  const pairs = plans.map((p) => [p.tier, p.tier_code]);
  const seen = new Set();
  return (pairs.length ? pairs : data.plan_tier ? [[data.plan_tier, null]] : [])
    .filter(([tier, code]) => {
      const k = String(code || tier || "").toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 2);
}

export function grantLabel(plan) {
  const items = plan.grant_items || [];
  if (items.length) {
    // 多权益桶（如 3 亿 token + 时长）逐条拼，只取第一条会把其余权益吞掉
    const parts = items.map((g) =>
      t("q.grant", {
        name: g.name,
        amount: fmtTokens(g.units),
        period: t(`q.period.${g.period}`, {}) === `q.period.${g.period}` ? g.period : t(`q.period.${g.period}`, {}),
      })
    );
    return parts.join(" + ");
  }
  return (plan.grants || [])[0] || "";
}

// 槽内条目：window 类按序、raw 池按 total 取最大值去重后降序；
// 去重键含套餐标签（__plan）：同名去重只针对同套餐内的上游重复行，
// 跨套餐（如 weekly build 与 start plan）同名池条不互吞
export function slotRows(items) {
  const list = items || [];
  const isWin = (it) => itemKind(it) !== "raw";
  const wins = list.filter(isWin);
  const best = new Map();
  for (const it of list) {
    if (isWin(it)) continue;
    const key = `${it.name}\u0001${it.__plan ?? ""}`;
    const cur = best.get(key);
    if (!cur || (it.total || 0) > (cur.total || 0)) best.set(key, it);
  }
  const pools = [...best.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
  return { wins, pools };
}

// 统一取条目（多套餐各自 items，每条打套餐标签 __plan）：
// 套餐无条目但直接挂 total/remaining 的池级兑底形态合成伪条目参与聚合；
// 套餐标签让同名去重只在同套餐内生效（weekly build 与 start plan 同名池条不互吞）
export function planItems(data) {
  const plans = data?.plans || [];
  if (plans.length) {
    return plans.flatMap((p, pi) => {
      const tag = p.name || p.tier || `plan${pi}`;
      const items = (p.items || []).length
        ? p.items
        : (p.total != null || p.remaining != null)
          ? [{ name: p.name || p.tier || "plan", total: p.total, remaining: p.remaining, percent_used: p.percent_used }]
          : [];
      return items.map((it) => ({ ...it, __plan: tag }));
    });
  }
  return (data?.items || []).map((it) => ({ ...it, __plan: "" }));
}

// 全账号额度聚合：按套餐分行（套餐名做前缀），同套餐跨账号求和。
// 不跨套餐合并：weekly build 与 start plan 的 tier_code 同为 start，只有套餐自己的
// plan_id/name 能区分；上限放宽到 6——双套餐各出窗口+池条已 4 行，截太紧又会吞掉排尾套餐
export function quotaTotals(datas) {
  const byLabel = new Map();
  const put = (l, it) => {
    if (it.total == null && it.remaining == null) return;
    const cur = byLabel.get(l) || { rem: 0, tot: 0 };
    cur.rem += it.remaining || 0;
    cur.tot += it.total || 0;
    byLabel.set(l, cur);
  };
  for (const data of datas) {
    if (!data) continue;
    for (const it of planItems(data)) {
      // 时长窗口（分钟）没有可加总的语义，且 fmtTokens 会把分钟排成 K/M 误导，排除
      if (itemKind(it) === "duration") continue;
      const base = itemKind(it) === "raw" ? balLabel(it.name) : windowLabel(it);
      put(it.__plan ? `${it.__plan} · ${base}` : base, it);
    }
  }
  return [...byLabel.entries()]
    .filter(([, v]) => v.rem > 0 || v.tot > 0)
    .slice(0, 6)
    .map(([label, v]) => ({ label, rem: v.rem, tot: v.tot }));
}
