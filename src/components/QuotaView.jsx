// 额度展示组件：DOM 结构与 class 名与原 innerHTML 模板逐一对应
import { Ic } from "./iconsx.jsx";
import { t } from "../lib/i18n.js";
import {
  fmtTokens, balLabel, expireInfo, tierChipOf, grantLabel, slotRows,
  itemKind, windowLabel, resetLabel,
} from "../lib/quotaView.js";

// 条与文字均为「已用」语义；剩余数值由各行 rem 文本表达
export function QuotaBar({ pct }) {
  const used = pct == null ? null : Math.min(100, Math.max(0, pct));
  const danger = used != null && used >= 90 ? " danger" : used != null && used >= 70 ? " warn" : "";
  const txt = used == null ? "--" : used.toFixed(0) + "%";
  const txtCls = (used ?? 0) >= 58 ? " in-fill" : "";
  return (
    <div className={"qbar" + danger}>
      <div className="qbar-fill" style={{ width: `${used ?? 0}%` }} />
      <span className={"qbar-pct" + txtCls}>{txt}</span>
    </div>
  );
}

export function TierChip({ tier, code }) {
  const { label, cls } = tierChipOf(tier, code);
  return <span className={"tier-b " + cls}>{label}</span>;
}

export function TierBadges({ pairs }) {
  if (!pairs || !pairs.length) return <span className="tier-b free" title={t("q.tierFree")}>{t("q.tierFree")}</span>;
  return <>{pairs.map(([tier, code], i) => <TierChip key={i} tier={tier} code={code} />)}</>;
}

function WinRow({ it, mini }) {
  const reset = it.reset || it.period_end ? resetLabel(it) : "";
  return (
    <div className={"q-win" + (mini ? " mini" : "")}>
      <span className="q-win-label">{windowLabel(it)}</span>
      <QuotaBar pct={it.percent_used} />
      <span className="q-win-reset" title={reset}>{reset}</span>
    </div>
  );
}

function BalRow({ it }) {
  const rem = it.total != null && it.remaining != null
    ? `${fmtTokens(it.remaining)}/${fmtTokens(it.total)}`
    : "";
  return (
    <div className="q-win mini">
      <span className="q-win-label" title={it.name}>{balLabel(it.name)}{it.window ? `·${it.window}` : ""}</span>
      <QuotaBar pct={it.percent_used} />
      <span className="q-win-reset">{rem}</span>
    </div>
  );
}

function SlotRows({ items }) {
  const { wins, pools } = slotRows(items);
  return (
    <>
      {wins.map((it, i) => <WinRow key={"w" + i} it={it} mini />)}
      {pools.map((it, i) => <BalRow key={"p" + i} it={it} />)}
    </>
  );
}

function PlanGroup({ plan }) {
  const label = plan.tier_code === "other" && !plan.pid ? t("q.other") : (plan.name || plan.tier || "");
  const exp = expireInfo(plan.expire, plan.starts);
  let expNode = null;
  if (exp) {
    const cls = "pg-exp" + (exp.warn ? " warn-line" : "");
    expNode = plan.starts
      ? (
        <span className={cls} title={t("q.validUntil", { date: exp.text })}>
          {t("q.validRangeShort", { start: plan.starts.slice(0, 10), end: exp.text })}
        </span>
      )
      : (
        <span className={cls} title={t("q.validUntil", { date: exp.text })}>
          {t("q.validUntilShort", { date: exp.text })}
        </span>
      );
  }
  return (
    <div className="plan-grp">
      <div className="pg-head">
        {plan.tier ? <TierChip tier={plan.tier} code={plan.tier_code} /> : null}
        <span className="pg-name" title={label}>{label}</span>
        {expNode}
      </div>
      <SlotRows items={plan.items} />
    </div>
  );
}

function ClaimStrip({ id, plan, disabled, onClaim }) {
  const grants = grantLabel(plan);
  const label = plan.name || plan.plan_id;
  return (
    <div className="claim-strip" title={plan.description || label}>
      <Ic name="gift" size={15} />
      <span className="claim-name">{label}</span>
      {grants ? <span className="claim-grants">{grants}</span> : null}
      <button className="btn-claim has-ic" onClick={() => onClaim(id)} disabled={disabled}>
        <Ic name="gift" size={13} /> {t("btn.claim")}
      </button>
    </div>
  );
}

// 待生效条：touch 空 + balance 反推出的「已领取未生效」态。只读展示，无领取按钮——
// effectiveAt 0 = 立即生效；时间格式 YYYY-MM-DD HH:mm（与领取 toast 同口径）
function PendingStrip({ pending }) {
  const fmt = (ts) => {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const bits = [];
  if (pending.effectiveAt === 0) bits.push(t("m.claimEffectiveNow"));
  else if (pending.effectiveAt) bits.push(t("m.claimEffectiveAt", { time: fmt(pending.effectiveAt) }));
  if (pending.endsAt) bits.push(t("m.claimEndsAt", { time: fmt(pending.endsAt) }));
  return (
    <div className="claim-strip pending" title={t("m.claimPendingTitle")}>
      <Ic name="gift" size={15} />
      <span className="claim-name">{pending.planName}</span>
      <span className="claim-grants">{bits.join(t("common.listSep"))}</span>
      <span className="btn-claim pending-tag">{t("m.claimPendingTag")}</span>
    </div>
  );
}

// 领取历史条：本地 claim-history.json 的已领取记录（userId 键，重登不丢）。
// 只读展示「已领取过 X · 领于 …」；仅无可领条且无待生效态时渲染——有可领条说明
// 服务端认为还能领，历史让位给可操作状态。
function HistoryStrip({ history }) {
  const fmt = (ts) => {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const latest = history[history.length - 1];
  if (!latest) return null;
  const when = fmt(latest.claimedAt);
  return (
    <div className="claim-strip history" title={t("m.claimHistoryTitle")}>
      <Ic name="check" size={15} />
      <span className="claim-name">{latest.planName}</span>
      <span className="claim-grants">{t("m.claimHistoryLine", { time: when })}</span>
    </div>
  );
}

export function AccountQuotaSlot({ id, quota, plan, pending, history, claimDisabled, onClaim }) {
  const strip = plan ? (
    <ClaimStrip id={id} plan={plan} disabled={claimDisabled} onClaim={onClaim} />
  ) : pending ? (
    <PendingStrip pending={pending} />
  ) : history?.length ? (
    <HistoryStrip history={history} />
  ) : null;

  let inner = null;
  if (quota?.busy) {
    inner = <span className="aq-loading">{t("q.loading")}</span>;
  } else if (quota?.err) {
    const msg = quota.err.length > 46 ? quota.err.slice(0, 46) + "…" : quota.err;
    inner = <span className="aq-err">{msg}</span>;
  } else if (quota?.data) {
    const plans = quota.data.plans || [];
    if (plans.length >= 1) {
      // 单套餐也带头：档位徽章 + 套餐名 + 有效期（此前单套餐只渲染条目，看不到套餐名）
      inner = <>{plans.map((p, i) => <PlanGroup key={i} plan={p} />)}</>;
    } else {
      const items = quota.data.items || [];
      const wins = items.filter((it) => itemKind(it) === "prompt_count");
      inner = wins.length
        ? <>{wins.map((it, i) => <WinRow key={i} it={it} mini />)}</>
        : <SlotRows items={items} />;
    }
  }

  if (!strip && !inner) return <div className="row-quota-slot" />;
  return (
    <div className="row-quota-slot">
      {strip}
      {inner}
    </div>
  );
}
