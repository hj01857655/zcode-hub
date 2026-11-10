// accounts.jsx — 账号管理页（从 App.jsx 拆出的独立页面组件）。
// 列表、搜索/筛选 chips、总额条、拖拽排序与池行跳转定位都在这里；
// 搜索词/筛选/拖拽是页面内临时态，随切页卸载自然重置（与原先内联时行为一致）。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Ic } from "../components/iconsx.jsx";
import { t, stripErr } from "../lib/i18n.js";
import {
  store, subscribe, getVersion, actions, runtimeFlags,
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
