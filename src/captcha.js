
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { applyNativeTheme, currentTheme } from "./lib/theme.js";
import { init, t, lang, stripErr } from "./lib/i18n.js";

const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
// 无痕单轮超时：桌面端 11-03 日志实测 SDK instanceReady 需 10.4s（网络差时），
// 8s 会在实例就绪前误判超时转人工。12s×3 轮=36s，仍在 auto 等待窗口 45s 内。
const TRACELESS_TIMEOUT = 12000;
// 无痕验证实测成功率 ≈ 1/2，靠重试兜底（2.3）。auto（隐藏窗静默领取）模式下
// 失败重试 2 次；手动模式不重试 —— 用户对着弹窗等 36 秒不如立刻看到按钮。
const AUTO_RETRY_MAX = 2;
const isAuto = new URLSearchParams(location.search).get("auto") === "1";

const $text = document.getElementById("cap-text");
const $detail = document.getElementById("cap-detail");
const $dot = document.getElementById("cap-dot");
const $btn = document.getElementById("cap-btn");

function status(text, tone = "run") {
  $text.textContent = text;
  $dot.className = "cap-dot" + (tone === "ok" ? " ok" : tone === "err" ? " err" : "");
}

function detail(text) {
  $detail.textContent = text || "";
}

document.addEventListener("securitypolicyviolation", (e) => {
  detail(t("c.cspBlocked", { directive: e.violatedDirective, uri: String(e.blockedURI).slice(0, 70) }));
});

const notifyStuck = () => { emit("captcha://interactive").catch(() => {}); };

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (typeof window.initAliyunCaptcha === "function") return resolve();
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(t("c.sdkFail")));
    document.head.appendChild(s);
  });
}

let submitted = false;
let region = null;
let tracelessTimer = 0;
let tracelessRound = 0;
let captchaInstance = null;

async function run() {
  try {
    const st = await invoke("get_state");
    if (st?.language) init(st.language);
  } catch { }
  // 与主窗口同源，localStorage 共享：跟随主题，避免浅色主界面弹出深色验证码窗
  document.documentElement.dataset.theme = localStorage.getItem("zcs-theme") || "dark";
  applyNativeTheme(currentTheme());
  document.title = t("c.title");
  $btn.textContent = t("c.btn");
  document.querySelector(".cap-foot").textContent = t("c.foot");
  status(t("c.preparing"));

  let cfg;
  try {
    cfg = await invoke("claim_captcha_config");
  } catch (e) {
    notifyStuck();
    status(t("c.cfgFail"), "err");
    detail(stripErr(e));
    return;
  }
  if (!cfg.enabled || !cfg.scene_id) {
    notifyStuck();
    status(t("c.cfgUnavailable"), "err");
    detail(t("c.cfgUnavailableDetail"));
    return;
  }
  region = cfg.region || null;
  try {
    await loadSdk();
  } catch (e) {
    notifyStuck();
    status(e.message || t("c.sdkFail"), "err");
    return;
  }

  window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };

  status(t("c.traceless"));

  const submit = (param) => {
    if (submitted || !param || !param.trim()) return;
    submitted = true;
    clearTimeout(tracelessTimer);
    status(t("c.passed"));
    invoke("claim_captcha_submit", { param, region }).catch((e) => {
      status(t("c.submitFail"), "err");
      detail(stripErr(e));
    });
  };

  const interactive = (why) => {
    notifyStuck();
    clearTimeout(tracelessTimer);
    status(t("c.interactive"));
    $btn.hidden = false;
    $btn.focus();
    if (why) detail(typeof why === "string" ? why.slice(0, 120) : JSON.stringify(why).slice(0, 120));
  };

  // 无痕失败先重试、重试耗尽才转人工（超时与 fail/onError 同走这条路）
  const retryOrFail = (why) => {
    clearTimeout(tracelessTimer);
    if (isAuto && !submitted && tracelessRound < AUTO_RETRY_MAX
        && typeof captchaInstance?.startTracelessVerification === "function") {
      tracelessRound++;
      try {
        captchaInstance.startTracelessVerification();
        status(t("c.tracelessRetry", { n: tracelessRound, max: AUTO_RETRY_MAX }));
        tracelessTimer = setTimeout(() => retryOrFail(), TRACELESS_TIMEOUT);
        return;
      } catch { /* SDK 拒绝重入：落人工 */ }
    }
    interactive(why);
  };

  try {
    window.initAliyunCaptcha({
      SceneId: cfg.scene_id,
      mode: "popup",
      language: lang() === "en" ? "en" : "zh-CN",
      showErrorTip: false,
      element: "#cap-holder",
      button: "#cap-btn",
      getInstance: (instance) => {
        captchaInstance = instance;
        if (typeof instance.startTracelessVerification === "function") {
          instance.startTracelessVerification();
          tracelessTimer = setTimeout(() => retryOrFail(), TRACELESS_TIMEOUT);
        } else {
          interactive();
        }
      },
      success: (param) => submit(typeof param === "string" ? param : param?.captchaVerifyParam),
      fail: (p) => retryOrFail(p),
      onError: (p) => retryOrFail(p),
    });
  } catch (e) {
    notifyStuck();
    status(t("c.initFail"), "err");
    detail(String(e));
  }
}

$btn.addEventListener("click", () => {
  if (!$btn.hidden) status(t("c.inPopup"));
});

run();
