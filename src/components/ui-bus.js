// UI 状态总线：非组件导出（toast / dismissSplash / open*Modal）单独成模块，
// 让 ui-react.jsx 只含组件导出，react-plugin 的 Fast Refresh 才不会整文件失效。
export const ui = { toasts: [], confirm: null, pw: null, provider: null, browserLogin: null };
let version = 0;
let toastSeq = 0;
const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getVersion = () => version;
export function emit() { version++; listeners.forEach((fn) => fn()); }

export function dismissSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 220);
}

const TOAST_MS = { plain: 3200, detail: 5200 };
// 每条 toast 的存活定时器：hover 暂停时清除，离开时按半程重排——
// 没有暂停的话 3.2s/5.2s 根本来不及选中复制报错内容
const toastTimers = new Map();

function armToast(id, ms) {
  clearTimeout(toastTimers.get(id));
  toastTimers.set(id, setTimeout(() => {
    toastTimers.delete(id);
    ui.toasts = ui.toasts.filter((x) => x.id !== id);
    emit();
  }, ms));
}

export function toast(msg, kind = "ok", detail = "") {
  const id = ++toastSeq;
  ui.toasts = [...ui.toasts, { id, msg: String(msg), kind, detail: detail ? String(detail) : "" }];
  emit();
  armToast(id, detail ? TOAST_MS.detail : TOAST_MS.plain);
}

// hover 暂停/恢复（Toast 组件 mouseenter/leave 接线）
export function toastHold(id, hold) {
  const t = ui.toasts.find((x) => x.id === id);
  if (!t) return;
  if (hold) clearTimeout(toastTimers.get(id));
  else armToast(id, (t.detail ? TOAST_MS.detail : TOAST_MS.plain) / 2);
}

export function openConfirmModal(m) {
  // 单槽位 + 排队：前一个确认未决时新确认入队，不覆盖丢 onYes
  if (ui.confirm) (ui.confirmQ ||= []).push(m);
  else ui.confirm = m;
  emit();
}
export function openPwModal(m) { ui.pw = m; emit(); }
export function openProviderModal(m) {
  // 已开着就不重开：连点/双触发会叠出多个弹窗（addAccount 无层守卫的唯一入口防重入点）
  if (ui.provider) return;
  ui.provider = m;
  emit();
}
export function openBrowserLoginModal(m) { ui.browserLogin = m; emit(); }
export function closeBrowserLoginModal() { if (ui.browserLogin) { ui.browserLogin = null; emit(); } }
