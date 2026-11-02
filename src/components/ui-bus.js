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

export function toast(msg, kind = "ok", detail = "") {
  const id = ++toastSeq;
  ui.toasts = [...ui.toasts, { id, msg: String(msg), kind, detail: detail ? String(detail) : "" }];
  emit();
  setTimeout(() => {
    ui.toasts = ui.toasts.filter((x) => x.id !== id);
    emit();
  }, detail ? 5200 : 3200);
}

export function openConfirmModal(m) {
  // 单槽位 + 排队：前一个确认未决时新确认入队，不覆盖丢 onYes
  if (ui.confirm) (ui.confirmQ ||= []).push(m);
  else ui.confirm = m;
  emit();
}
export function openPwModal(m) { ui.pw = m; emit(); }
export function openProviderModal(m) { ui.provider = m; emit(); }
export function openBrowserLoginModal(m) { ui.browserLogin = m; emit(); }
export function closeBrowserLoginModal() { if (ui.browserLogin) { ui.browserLogin = null; emit(); } }
