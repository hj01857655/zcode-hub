// 首帧前应用持久化主题：闪屏与 body 底色随主题，避免亮色主题启动黑闪。
// CSP script-src 'self' 禁内联 → 必须是外部文件；放 public/ 由 Vite 原样拷贝。
// 只设 data-theme（main.jsx 兕底逻辑互认：已设则不再覆盖）。
(function () {
  try {
    var th = localStorage.getItem("zcs-theme");
    if (th === "light" || th === "dark") {
      document.documentElement.dataset.theme = th;
    }
  } catch (e) {
    /* localStorage 不可用时保持默认暗色 */
  }
})();
