// React 版关于页：版本、应用内更新、版本回退、功能特性、账号库安全说明、上游仓库（自设置页迁出）
// 视觉：平铺整页，与设置页同语言（无卡片壳，panel 分区 + hairline + amber 点缀）
// 订阅 store：语言快捷钮切换时本页文案即时跟随，不需切走再切回
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "../lib/i18n.js";
import { updateErrText } from "../lib/updater.js";
import { subscribe, getVersion } from "../lib/store.js";

function Feature({ title, desc }) {
  return (
    <div className="about-feat">
      <div className="about-feat-title">{title}</div>
      <div className="about-feat-desc">{desc}</div>
    </div>
  );
}

// 应用内更新：关于页手动检查（另有启动后全局静默检查，见 lib/updater.js 与 store.boot）；
// 发现新版本后下载并安装，Windows 下安装器自行接管重启，relaunch 兜底其余平台
const UP_IDLE = { st: "idle", ver: "", pct: 0, err: "" };

// 版本回退：列表由 Rust 侧 releases.atom + 内置兜底给出，选择后 pinned 到不可变 tag 安装。
// Windows 下安装器会自行退出并重启，故 Finished 事件（下载完成）就把 UI 切到「安装中」。
const RB_IDLE = { st: "idle", versions: [], ver: "", pct: 0, err: "" };

// 上次检查时间的本地存储键（无需后端：检查是本页发起的纯前端行为）
const LAST_CHECK_KEY = "about.lastUpdateCheck";

export default function AboutPage() {
  useSyncExternalStore(subscribe, getVersion);
  const [appVer, setAppVer] = useState("");
  const [up, setUp] = useState(UP_IDLE);
  const [rb, setRb] = useState(RB_IDLE);
  const [lastCheck, setLastCheck] = useState(() => localStorage.getItem(LAST_CHECK_KEY) || "");
  const upRef = useRef(null);
  const rbBusyRef = useRef(false);
  useEffect(() => {
    invoke("app_version").then((v) => setAppVer(v || "")).catch(() => setAppVer("-"));
  }, []);

  async function loadRollbacks() {
    if (rbBusyRef.current) return;
    setRb({ ...RB_IDLE, st: "loading" });
    try {
      const versions = await invoke("rollback_versions");
      if (!versions || versions.length === 0) {
        setRb({ ...RB_IDLE, st: "empty" });
        return;
      }
      setRb({ ...RB_IDLE, st: "list", versions, ver: versions[0].version });
    } catch (e) {
      setRb({ ...RB_IDLE, st: "err", err: String(e) });
    }
  }

  async function runCheck() {
    // 连点防护：checking/downloading 中再点直接忽略（st 是同步状态，setState 异步不依赖它）
    if (up.st === "checking" || up.st === "downloading") return;
    if (rbBusyRef.current) return;
    setUp({ ...UP_IDLE, st: "checking" });
    const at = new Date().toISOString();
    try {
      const u = await check();
      localStorage.setItem(LAST_CHECK_KEY, at);
      setLastCheck(at);
      if (!u) { setUp({ ...UP_IDLE, st: "latest" }); return; }
      upRef.current = u;
      setUp({ ...UP_IDLE, st: "available", ver: u.version });
    } catch (e) {
      setUp({ ...UP_IDLE, st: "err", err: String(e) });
    }
  }

  async function doInstall() {
    if (up.st !== "available") return;
    setUp((s) => ({ ...s, st: "downloading", pct: 0 }));
    try {
      let received = 0;
      let total = 0;
      await upRef.current.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength || 0;
        } else if (evt.event === "Progress") {
          received += evt.data.chunkLength;
          if (total > 0) {
            const pct = Math.min(100, Math.round((received / total) * 100));
            setUp((s) => (s.st === "downloading" ? { ...s, pct } : s));
          }
        } else if (evt.event === "Finished") {
          setUp((s) => ({ ...s, pct: 100 }));
        }
      });
      await relaunch();
    } catch (e) {
      setUp({ ...UP_IDLE, st: "err", err: String(e) });
    }
  }

  async function doRollback() {
    const version = rb.ver;
    if (!version || rbBusyRef.current) return;
    rbBusyRef.current = true;
    setRb((s) => ({ ...s, st: "downloading", pct: 0, err: "" }));
    const ch = new Channel();
    let received = 0;
    let total = 0;
    ch.onmessage = (evt) => {
      if (evt.event === "Started") {
        total = evt.data.contentLength || 0;
      } else if (evt.event === "Progress") {
        received += evt.data.chunkLength || 0;
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          setRb((s) => (s.st === "downloading" ? { ...s, pct } : s));
        }
      } else if (evt.event === "Finished") {
        setRb((s) => (s.st === "downloading" ? { ...s, st: "done", pct: 100 } : s));
      }
    };
    try {
      await invoke("rollback_to", { version, onEvent: ch });
      await relaunch();
    } catch (e) {
      // 回退下载/验签/安装失败与列表拉取失败分别走不同文案，便于定位故障层
      setRb({ ...RB_IDLE, st: "err", err: String(e), fail: true });
    } finally {
      rbBusyRef.current = false;
    }
  }

  // 相对时间（几分钟前/几小时前/几天前），避免时区换算噪音
  const lastCheckText = (() => {
    if (!lastCheck) return "";
    const ms = Date.now() - new Date(lastCheck).getTime();
    if (ms < 60_000) return t("a.lastCheckJust");
    if (ms < 3_600_000) return t("a.lastCheckMin", { n: Math.floor(ms / 60_000) });
    if (ms < 86_400_000) return t("a.lastCheckHour", { n: Math.floor(ms / 3_600_000) });
    return t("a.lastCheckDay", { n: Math.floor(ms / 86_400_000) });
  })();

  const updRow =
    up.st === "idle" ? (
      <>
        <button type="button" className="btn-ghost" onClick={runCheck}>{t("a.updCheck")}</button>
        {lastCheckText && <span className="about-upd-hint">{t("a.lastCheck", { at: lastCheckText })}</span>}
      </>
    ) : up.st === "checking" ? (
      <span className="about-upd-hint">{t("a.updChecking")}</span>
    ) : up.st === "latest" ? (
      <>
        <span className="about-upd-hint">{t("a.updLatest")}</span>
        <span className="about-upd-hint">{t("a.lastCheck", { at: lastCheckText })}</span>
      </>
    ) : up.st === "available" ? (
      <>
        <span className="about-upd-hint">{t("a.updAvailable", { ver: up.ver })}</span>
        <button type="button" className="btn-ghost" onClick={doInstall}>{t("a.updInstall")}</button>
      </>
    ) : up.st === "downloading" ? (
      <div className="about-dl">
        <div className="about-dl-bar"><div className="about-dl-fill" style={{ width: `${up.pct}%` }} /></div>
        <span className="about-upd-hint">{t("a.updDownloading")} {up.pct}%</span>
      </div>
    ) : (
      <>
        {/* 展示映射后的短句，原始 Rust 错误挂 title 供排查 */}
        <span className="about-upd-err" title={up.err}>{t("a.updFail", { err: updateErrText(up.err) })}</span>
        <button type="button" className="btn-ghost" onClick={runCheck}>{t("a.updRetry")}</button>
      </>
    );

  const rbBody = (() => {
    if (rb.st === "idle") {
      return (
        <div className="about-rb-row">
          <button type="button" className="btn-ghost" onClick={loadRollbacks}>{t("a.rbPick")}</button>
          {appVer && <span className="about-upd-hint">{t("a.rbCurrent", { ver: appVer })}</span>}
        </div>
      );
    }
    if (rb.st === "loading") return <div className="about-upd-hint">{t("a.rbLoading")}</div>;
    if (rb.st === "empty") {
      return (
        <div className="ui-empty compact">
          <div className="ui-empty-title">{t("a.rbEmpty")}</div>
          <button type="button" className="btn-ghost" onClick={loadRollbacks}>{t("a.rbRetry")}</button>
        </div>
      );
    }
    if (rb.st === "err") {
      return (
        <div className="ui-empty compact err">
          <span className="about-upd-err" title={rb.err}>
            {rb.fail ? t("a.rbFail", { err: updateErrText(rb.err) }) : t("a.rbErr", { err: updateErrText(rb.err) })}
          </span>
          <button type="button" className="btn-ghost" onClick={loadRollbacks}>{t("a.rbRetry")}</button>
        </div>
      );
    }
    if (rb.st === "downloading" || rb.st === "done") {
      return (
        <div className="about-dl">
          <div className="about-dl-bar"><div className="about-dl-fill" style={{ width: `${rb.pct}%` }} /></div>
          <span className="about-upd-hint">
            {rb.st === "done" ? t("a.rbDone") : `${t("a.rbDownloading", { ver: rb.ver })} ${rb.pct}%`}
          </span>
        </div>
      );
    }
    if (rb.st === "confirm") {
      return (
        <div className="about-rb-row">
          <span className="about-upd-hint">{t("a.rbConfirmDesc", { ver: rb.ver })}</span>
          <button type="button" className="btn-ghost" onClick={doRollback}>{t("a.rbConfirm")}</button>
          <button type="button" className="btn-ghost" onClick={() => setRb((s) => ({ ...s, st: "list" }))}>{t("a.rbCancel")}</button>
        </div>
      );
    }
    return (
      <div className="about-rb-row">
        <label className="ui-label" htmlFor="rb-ver">{t("a.rbPick")}</label>
        <select id="rb-ver" className="about-rb-sel" value={rb.ver}
          onChange={(e) => setRb((s) => ({ ...s, ver: e.target.value }))}>
          {rb.versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version}{v.published ? ` · ${v.published}` : ""}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost" onClick={() => setRb((s) => ({ ...s, st: "confirm" }))}>{t("a.rbGo")}</button>
        <button type="button" className="btn-mini" onClick={loadRollbacks}>{t("a.rbLoad")}</button>
        {appVer && <span className="about-upd-hint">{t("a.rbCurrent", { ver: appVer })}</span>}
      </div>
    );
  })();

  return (
    <div className="about-wrap">
      <div className="about-card">
        <div className="about-brand">
          <span className="about-mark">Z·HUB</span>
          {appVer === ""
            ? <span className="about-ver-skel" aria-label={t("a.verLabel")} />
            : appVer !== "-" && <span className="about-ver">v{appVer}</span>}
          <span className="about-tagline">{t("a.tagline")}</span>
        </div>

        <div className="about-block about-upd ui-sec first">
          <div className="ui-sec-title">{t("a.updLabel")}</div>
          <div className="about-upd-row">{updRow}</div>
        </div>

        <div className="about-block ui-sec">
          <div className="ui-sec-title">{t("a.rbLabel")}</div>
          <div className="ui-note">{t("a.rbDesc")}</div>
          <div className="about-rb-body">{rbBody}</div>
        </div>

        <div className="about-block ui-sec">
          <div className="ui-sec-title">{t("a.featLabel")}</div>
          <div className="about-feats">
            <Feature title={t("a.feat1t")} desc={t("a.feat1d")} />
            <Feature title={t("a.feat2t")} desc={t("a.feat2d")} />
            <Feature title={t("a.feat3t")} desc={t("a.feat3d")} />
            <Feature title={t("a.feat4t")} desc={t("a.feat4d")} />
          </div>
        </div>

        <div className="about-block ui-sec">
          <div className="ui-sec-title">{t("a.safetyLabel")}</div>
          <p>{t("s.hint")}</p>
          <p>{t("a.safetyDetail")}</p>
        </div>

        <a className="about-repo" href="https://github.com/hj01857655/zcode-hub" target="_blank" rel="noopener"
          onClick={(e) => { e.preventDefault(); invoke("open_external", { url: "https://github.com/hj01857655/zcode-hub" }).catch(() => {}); }}>
          <span className="about-repo-line">{t("a.repoLabel")}</span>
          <span className="about-repo-url">github.com/hj01857655/zcode-hub</span>
          <span className="about-repo-desc">{t("s.githubLink")}</span>
        </a>

        <div className="about-foot">{t("a.credit")}</div>
      </div>
    </div>
  );
}
