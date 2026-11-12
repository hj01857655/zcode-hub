// accounts.jsx — 账号管理页（从 App.jsx 拆出的独立页面组件）。
// 列表、搜索/筛选 chips、总额条、拖拽排序与池行跳转定位都在这里；
// 搜索词/筛选/拖拽是页面内临时态，随切页卸载自然重置（与原先内联时行为一致）。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Ic } from "../components/iconsx.jsx";
import { t, stripErr } from "../lib/i18n.js";
import {
  store, subscribe, getVersion, actions, runtimeFlags, emit,
  notchColor, autoPillTitle,
} from "../lib/store.js";
import { expireInfo, tierBadges, quotaTotals, fmtTokens } from "../lib/quotaView.js";
import { toast } from "../components/ui-bus.js";
import { AccountQuotaSlot, TierBadges } from "../components/QuotaView.jsx";

function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store;
}

function Toolbar({ s, claimableCount, unsaved }) {
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const cooling = Date.now() < refreshClaim.cooldownUntil;
  return (
    <section className="toolbar">
      {/* 防丢号直入口：ZCode 在跑且登录未入库时，保存动作不再藏在添加弹窗里 */}
      {unsaved ? (
        <button
          className="btn-ghost has-ic save-login-cta"
          onClick={() => actions.capture()}
          title={t("btn.captureTitle")}
        >
          <Ic name="check" size={16} /> {t("btn.saveLogin")}
        </button>
      ) : null}
      {claimableCount > 0 ? (
        <button
          className="btn-ghost has-ic claim-all"
          onClick={() => actions.claimAll()}
          disabled={claimAllRunning || refreshClaim.running || autoClaimRunning}
          title={t("btn.claimAllTitle")}
        >
          <Ic name="gift" size={16} /> {t("btn.claimAll")}
          {claimableCount > 1 ? ` (${claimableCount})` : ""}
        </button>
      ) : null}

      {s.accounts.length > 0 ? (
        <button
          className="btn-ghost has-ic"
          onClick={() => actions.refreshClaim()}
          disabled={refreshClaim.running || claimAllRunning || cooling}
          title={cooling && !refreshClaim.running
            ? t("btn.refreshClaimCooldownTitle", { n: Math.ceil((refreshClaim.cooldownUntil - Date.now()) / 1000) })
            : t("btn.refreshClaimTitle")}
        >
          <Ic name="refresh" size={16} />{" "}
          {refreshClaim.running
            ? t("btn.refreshClaimRunning", { done: refreshClaim.done, total: refreshClaim.total })
            : t("btn.refreshClaim")}
        </button>
      ) : null}

      <button
        className={"tog-inline" + (s.auto_claim ? " on" : "") + (autoClaimRunning ? " running" : "")}
        role="switch"
        aria-checked={s.auto_claim}
        aria-label={t("btn.autoClaim")}
        title={autoPillTitle(s)}
        onClick={() => actions.toggleAutoClaim()}
      >
        <span className={"toggle" + (s.auto_claim ? " on" : "")} aria-hidden="true">
          <span className="knob" />
        </span>
        {t("btn.autoClaim")}
      </button>

      <button className="btn-primary has-ic" onClick={() => actions.addAccount()} title={t("btn.addAccountTitle")}>
        <Ic name="userPlus" size={16} /> {t("btn.addAccount")}
      </button>

      <span className="tb-sep" aria-hidden="true" />
      {s.zcode_running ? (
        <button className="btn-ghost has-ic" onClick={() => actions.askKill()} title={t("btn.killZcode")}>
          <Ic name="power" size={16} /> {t("btn.killZcode")}
        </button>
      ) : (
        <button className="btn-ghost has-ic" onClick={() => actions.launch()} disabled={!s.zcode_path_ok}>
          <Ic name="play" size={14} /> {t("btn.launchZcode")}
        </button>
      )}

      <span className="tb-spacer" />
    </section>
  );
}

function RenameRow({ a, isActive }) {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className={"row" + (isActive ? " active" : "")} data-id={a.id}>
      <span className="notch" style={{ background: notchColor(a.id) }} />
      <div className="row-main">
        <input
          ref={inputRef}
          className="rename-input"
          value={store.renamingText}
          maxLength={40}
          onChange={(e) => actions.setRenamingText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") actions.doRename(a.id);
            if (e.key === "Escape") actions.cancelRename();
          }}
          onBlur={() => actions.deferCancelRename(a.id)}
        />
        <div className="row-meta">{t("btn.renameMeta")}</div>
      </div>
      <div className="row-actions">
        <button className="btn-ghost btn-mini" onClick={() => actions.doRename(a.id)}>
          {t("common.save")}
        </button>
        <button className="btn-ghost btn-mini" onClick={() => actions.cancelRename()}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function AccountRow({ a, quota, plan, claimDisabled }) {
  const isActive = a.is_active;
  if (store.renaming === a.id) return <RenameRow a={a} isActive={isActive} />;

  const ident = [a.identity?.username, a.identity?.email].filter(Boolean).join(" · ");
  const exp = expireInfo(quota?.data?.plan_expire, quota?.data?.plan_starts);
  const metaBits = [];
  if (!a.has_config) metaBits.push(<span key="cfg" className="no-cfg">{t("q.noCfg")}</span>);
  if (exp) {
    // 分色与仪表盘对齐：≤5 天红（soon）、≤7 天黄（warn）；短窗口批次（≤48h）不算告警
    metaBits.push(
      <span key="exp" className={exp.soon ? "soon-line" : exp.warn ? "warn-line" : ""}>
        {t("q.validUntil", { date: exp.text })}
      </span>,
    );
  }
  if (ident) {
    if (metaBits.length) metaBits.push(<span key="sep">{" · "}</span>);
    metaBits.push(<span key="ident">{ident}</span>);
  }

  const badges = tierBadges(quota?.data);

  return (
    <div className={"row" + (isActive ? " active" : "")} data-id={a.id}>
      <div className="row-top">
        <span className="notch" style={{ background: notchColor(a.id) }} />
        <div className="row-main">
          <div className="row-name">
            {a.name}
            <TierBadges pairs={badges} />
            {isActive ? <span className="tag-use">{t("btn.inUse")}</span> : null}
            {a.has_user_info === false
              ? <span className="tag-relogin" title={t("btn.reloginTitle")}>{t("btn.relogin")}</span>
              : null}
            {a.jwt_expired
              ? <span className="tag-relogin" title={t("btn.jwtExpiredTitle")}>{t("btn.jwtExpired")}</span>
              : null}
          </div>
          <div className="row-meta">{metaBits}</div>
        </div>
        <div className="row-actions">
          <button
            className={"icon-btn" + (isActive ? " on" : "") + (store.switchingId === a.id ? " switching" : "")}
            title={store.switchingId === a.id ? t("btn.switching") : isActive ? t("btn.current") : t("btn.switch")}
            aria-label={store.switchingId === a.id ? t("btn.switching") : isActive ? t("btn.current") : t("btn.switch")}
            onClick={() => actions.askSwitch(a.id)}
            disabled={isActive || store.switching}
          >
            <Ic name={store.switchingId === a.id ? "refresh" : isActive ? "check" : "swap"} size={16} />
          </button>
          <button className="icon-btn" title={t("btn.quota")} aria-label={t("btn.quota")} onClick={() => actions.acctQuota(a.id)}>
            <Ic name="gauge" size={16} />
          </button>
          <button
            className={"icon-btn" + (store.claimable[a.id]?.busy ? " on" : "")}
            title={t("btn.refreshClaimOne")}
            aria-label={t("btn.refreshClaimOne")}
            onClick={() => actions.refreshClaimOne(a.id)}
            disabled={claimDisabled || store.claimable[a.id]?.busy}
          >
            <Ic name="gift" size={16} />
          </button>
          <button className="icon-btn" title={t("btn.rename")} aria-label={t("btn.rename")} onClick={() => actions.rename(a.id)}>
            <Ic name="pen" size={16} />
          </button>
          <button className="icon-btn" title={t("btn.export")} aria-label={t("btn.export")} onClick={() => actions.exportOne(a.id)}>
            <Ic name="export" size={16} />
          </button>
          <button className="icon-btn danger" title={t("btn.delete")} aria-label={t("btn.delete")} onClick={() => actions.delete(a.id)}>
            <Ic name="x" size={16} />
          </button>
        </div>
      </div>
      <AccountQuotaSlot
        id={a.id}
        quota={quota}
        plan={plan}
        pending={!plan ? store.claimable[a.id]?.pending || null : null}
        history={!plan && !store.claimable[a.id]?.pending ? store.claimHistory[a.id]?.history || null : null}
        claimDisabled={claimDisabled}
        onClaim={(id) => actions.claim(id)}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="ui-empty">
      <Ic name="empty" size={30} />
      <div className="ui-empty-title">{t("m.emptyTitle")}</div>
      <div className="ui-empty-desc">{t("ui.emptyAccounts")}</div>
    </div>
  );
}

// 账号页本体：工具条 + 标题/搜索 + 筛选 chips + 总额条 + 列表（含拖拽排序、跳转定位闪灯）
// focusAcc 由 App 层传入（网关页/仪表盘的 onOpenAccount）：本页切走即卸载，定位目标不能存在页内 state。
export default function AccountsPage({ focusAcc, onFocusDone }) {
  const s = useStore();
  const listRef = useRef(null);
  const [accQuery, setAccQuery] = useState("");
  const searchRef = useRef(null);
  // 状态筛选 chips：all / claimable / pending / relogin（与文本搜索叠加）
  const [accFilter, setAccFilter] = useState("all");
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  // 定位闪灯（由网关页/仪表盘的 onOpenAccount 触发）：清过滤 → 滚动 → 闪一次边框
  useEffect(() => {
    if (!focusAcc) return;
    // 跳转目标必须可见：搜索词/筛选可能把目标行过滤掉导致 scrollIntoView 静默失效
    if (accQuery) setAccQuery("");
    if (accFilter !== "all") setAccFilter("all");
    const el = listRef.current?.querySelector(`[data-acc="${focusAcc}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("acc-flash");
    const timer = setTimeout(() => { el.classList.remove("acc-flash"); onFocusDone(); }, 1700);
    return () => clearTimeout(timer);
  }, [focusAcc]);

  const st = s.state;
  const active = st.accounts.find((a) => a.is_active) || null;
  const claimableCount = st.accounts.filter((a) => (s.claimable[a.id]?.plans || []).length > 0).length;
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const claimDisabled = claimAllRunning || refreshClaim.running || claimActive || autoClaimRunning;

  const accQ = accQuery.trim().toLowerCase();
  // 状态筛选谓词（与文本搜索叠加）：可领 / 待生效 / 需重登（含 JWT 过期）
  const ACC_FILTERS = {
    all: null,
    claimable: (a) => (s.claimable[a.id]?.plans || []).length > 0,
    pending: (a) => !!s.claimable[a.id]?.pending,
    relogin: (a) => a.has_user_info === false || a.jwt_expired,
  };
  const shownAccs = st.accounts.filter((a) => {
    if (accQ && !(a.name.toLowerCase().includes(accQ) || a.id.toLowerCase().includes(accQ))) return false;
    const pred = ACC_FILTERS[accFilter] || ACC_FILTERS.all;
    return pred ? pred(a) : true;
  });
  // 各档计数（全量口径，不随当前筛选变——计数是导航辅助，不是结果统计）
  const filterCounts = {
    all: st.accounts.length,
    claimable: claimableCount,
    pending: st.accounts.filter((a) => !!s.claimable[a.id]?.pending).length,
    relogin: st.accounts.filter((a) => a.has_user_info === false || a.jwt_expired).length,
  };
  const accTotals = quotaTotals(st.accounts.map((a) => store.acctQuota[a.id]?.data).filter(Boolean));

  // 拖拽落位（#15）：按全量列表算新序，持久化成功后才改本地，失败回滚为后端序
  const dropTo = (targetId) => {
    const from = st.accounts.findIndex((x) => x.id === dragId);
    const to = st.accounts.findIndex((x) => x.id === targetId);
    const movedId = dragId;
    setDragId(null); setOverId(null);
    if (!movedId || from < 0 || to < 0 || from === to) return;
    const list = [...st.accounts];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    invoke("set_account_order", { ids: list.map((x) => x.id) })
      .then(() => { store.state.accounts = list; emit(); })
      .catch((e) => toast(stripErr(e), "err"));
  };

  return (
    <>
      <Toolbar s={st} claimableCount={claimableCount} unsaved={st.live_logged_in && !active} />
      <div className="section-head">
        <h2>{t("m.accounts")}</h2>
        <span className="count">{(accQ || accFilter !== "all") ? `${shownAccs.length}/${st.accounts.length}` : t("m.count", { count: st.accounts.length })}</span>
        {st.accounts.length ? (
          <input
            ref={searchRef}
            className="acc-search"
            type="search"
            value={accQuery}
            placeholder={t("m.searchPh")}
            onChange={(e) => setAccQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape 清空并还焦点：搜索是临时态，键盘一条路走完
              if (e.key === "Escape" && accQuery) {
                e.stopPropagation();
                setAccQuery("");
                searchRef.current?.focus();
              }
            }}
          />
        ) : null}
      </div>
      {/* 状态筛选 chips：与文本搜索叠加；各档计数为全量口径（导航辅助） */}
      {st.accounts.length ? (
        <div className="acc-filters">
          {[["all", t("f.all")], ["claimable", t("f.claimable")], ["pending", t("f.pending")], ["relogin", t("f.relogin")]].map(([key, label]) => (
            <button
              key={key}
              className={"acc-chip" + (accFilter === key ? " on" : "")}
              onClick={() => setAccFilter(accFilter === key ? "all" : key)}
            >
              {label}{filterCounts[key] ? ` ${filterCounts[key]}` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {st.accounts.length ? (
        <div className="dash-sub">
          {t("d.quotaTotal")}
          {accTotals.length
            ? accTotals.map((v) => (
                <span key={v.label} className="dash-q">
                  {v.label} <b>{t("q.remainShort")} {fmtTokens(v.rem)}/{fmtTokens(v.tot)}</b>
                </span>
              ))
            : <span className="dash-q dash-q-pending">…</span>}
        </div>
      ) : null}
      <main className="list" ref={listRef}>
        {st.accounts.length === 0 ? <EmptyState /> : shownAccs.length === 0 ? <div className="dash-empty">{t("m.searchNoMatch")}</div> : shownAccs.map((a) => (
          <div key={a.id} data-acc={a.id}
            className={"acc-item"
              + (dragId === a.id ? " acc-dragging" : "")
              + (dragId && dragId !== a.id && overId === a.id ? " acc-over" : "")}
            draggable={dragId === a.id}
            onMouseUp={() => { if (dragId === a.id) setDragId(null); }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              try { e.dataTransfer.setData("text/plain", a.id); } catch { /* noop */ }
            }}
            onDragOver={(e) => { if (dragId && !accQ) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverId(a.id); } }}
            onDrop={(e) => { if (dragId && !accQ) { e.preventDefault(); dropTo(a.id); } }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
          >
            {!accQ && st.accounts.length > 1 ? (
              <span className="acc-grip" title={t("m.dragHint")}
                onMouseDown={() => setDragId(a.id)}>
                <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
                  {[3, 7, 11].map((cy) => (
                    <g key={cy}>
                      <circle cx="3" cy={cy} r="1.2" /><circle cx="7" cy={cy} r="1.2" />
                    </g>
                  ))}
                </svg>
              </span>
            ) : null}
            <div className="acc-body">
              <AccountRow
                a={a}
                quota={s.acctQuota[a.id]}
                plan={s.claimable[a.id]?.plans?.[0] || null}
                claimDisabled={claimDisabled}
              />
            </div>
          </div>
        ))}
      </main>
    </>
  );
}
