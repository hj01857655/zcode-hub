// 邀请页：全账号 referral 总览（受邀任务四格 / 我的邀请码 / 助力进度 / 绑码）。
// 独立页而非卡片内展开——账号卡已有额度槽+领取条，批量对码也需要全账号一张表。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t, lang } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";
import { store, actions, loadAllReferrals, subscribe, getVersion } from "../lib/store.js";

const TASK_KEYS = ["login_device", "referral_bind_code", "referral_new_user_reward", "send_message"];

// 奖励中心邀请链接：好友打开后页面自动带码，点接受即完成绑码
function inviteLink(code) {
  return `https://zcode.z.ai/${lang() === "en" ? "en" : "cn"}/rewards?invite_code=${code}`;
}

function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store;
}

function TaskChips({ tasks }) {
  const byKey = Object.fromEntries((tasks || []).map((x) => [x.key, !!x.completed]));
  return (
    <span className="rf-tasks">
      {TASK_KEYS.map((k) => {
        const done = byKey[k] === true;
        const absent = !(k in byKey);
        return (
          <span
            key={k}
            className={"rf-task-chip" + (done ? " ok" : absent ? " absent" : "")}
            title={absent ? t("r.taskAbsent") : done ? t("r.taskDone") : t("r.taskPending")}
          >
            {t("r.task." + k)}
          </span>
        );
      })}
    </span>
  );
}

function BindCell({ id, bound }) {
  const [code, setCode] = useState("");
  if (bound) return <span className="rf-bound-ok"><Ic name="check" size={13} /> {t("r.boundOk")}</span>;
  return (
    <span className="rf-bind">
      <input
        className="rf-code-input"
        value={code}
        maxLength={12}
        placeholder={t("r.codePlaceholder")}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim()) actions.referralBind(id, code);
        }}
      />
      <button className="btn-ghost has-ic" disabled={!code.trim()} onClick={() => actions.referralBind(id, code)}>
        <Ic name="link" size={13} /> {t("r.bindBtn")}
      </button>
    </span>
  );
}

function ReferralRow({ a }) {
  const r = store.referral[a.id] || {};
  const inv = r.summary?.invitee || null;
  const mine = r.summary?.inviter || null;
  const invitees = r.invitees?.invitees || [];
  const bound = (inv?.tasks || []).some((x) => x.key === "referral_bind_code" && x.completed);
  const assistDone = invitees.filter((x) => x.assisted).length;

  return (
    <div className="rf-row">
      <div className="rf-name" title={a.id}>{a.name}</div>
      <div className="rf-cell">
        {r.busy ? <span className="aq-loading">{t("r.loading")}</span>
          : r.err ? <span className="aq-err" title={r.err}>{r.err}</span>
          : inv ? <TaskChips tasks={inv.tasks} />
          : <span className="rf-none">{t("r.notInvited")}</span>}
      </div>
      <div className="rf-cell rf-code-cell">
        {mine?.invite_code ? (
          <>
            <code className="rf-code" title={t("r.myCodeTitle")}>{mine.invite_code}</code>
            <button
              className="icon-btn rf-copy"
              title={t("r.copyLink")}
              onClick={() => navigator.clipboard?.writeText(inviteLink(mine.invite_code))}
            >
              <Ic name="export" size={13} />
            </button>
            {invitees.length ? (
              <span className={"rf-count" + (assistDone > 0 ? " hit" : "")}>{t("r.assistCount", { done: assistDone, total: invitees.length })}</span>
            ) : null}
          </>
        ) : <span className="rf-none">—</span>}
      </div>
      <div className="rf-cell">
        {r.busy ? <span className="rf-none">…</span> : <BindCell id={a.id} bound={bound} />}
      </div>
    </div>
  );
}

export default function ReferralPage() {
  useStore();
  const loadedIds = useRef(new Set());

  const accounts = store.state?.accounts || [];
  const idKey = accounts.map((a) => a.id).join(",");

  useEffect(() => {
    if (!idKey) return;
    // 只补载没拉过的账号（导入/新增后进页也生效）；刷新按钮才做全量重拉
    const need = idKey.split(",").filter((id) => !loadedIds.current.has(id));
    if (!need.length) return;
    need.forEach((id) => loadedIds.current.add(id));
    loadAllReferrals(need);
  }, [idKey]);

  const anyBusy = accounts.some((a) => store.referral[a.id]?.busy);

  return (
    <div className="settings">
      <div className="section-head">
        <h2>{t("r.menu")}</h2>
        <button
          className="btn-ghost has-ic"
          disabled={anyBusy}
          onClick={() => loadAllReferrals(accounts.map((a) => a.id))}
        >
          <Ic name="refresh" size={14} cls={anyBusy ? "spin" : ""} /> {t("r.refreshAll")}
        </button>
      </div>
      <div className="ui-sec">
        <div className="ui-sec-title"><span>{t("ui.secRefTable")}</span></div>
        <div className="ui-scroll-x">
          <div className="ui-table-wrap">
            <div className="rf-head rf-row">
              <div>{t("r.colAccount")}</div>
              <div>{t("r.colTasks")}</div>
              <div>{t("r.colMyCode")}</div>
              <div>{t("r.colBind")}</div>
            </div>
            {accounts.map((a) => <ReferralRow key={a.id} a={a} />)}
          </div>
        </div>
        {accounts.length === 0
          ? <div className="ui-empty">
              <Ic name="empty" size={28} />
              <div className="ui-empty-title">{t("m.emptyTitle")}</div>
              <div className="ui-empty-desc">{t("ui.emptyRef")}</div>
            </div>
          : null}
        <div className="ui-note">{t("r.pageHint")}</div>
      </div>
    </div>
  );
}
