// React 渲染层入口：挂载 App，原生 JS 版 main.js 保留未动（回退切回 index.html 的 script 即可）
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// 右键菜单与快捷键屏蔽逻辑在 ui-react.jsx 副作用里
import "./components/ui-react.jsx";

// 主题早挂：渲染前应用持久化主题，避免首帧闪错色
import { currentTheme, applyNativeTheme } from "./lib/theme.js";
import { invoke } from "@tauri-apps/api/core";
if (!document.documentElement.dataset.theme) {
  document.documentElement.dataset.theme = localStorage.getItem("zcs-theme") || "dark";
}
applyNativeTheme(currentTheme());
// 回填 Rust 侧主题落盘（boot-theme.js 已设则值一致，幂等）
invoke("set_theme_pref", { th: currentTheme() }).catch(() => {});

// macOS 玻璃：UA 嗅探挂 html.mac 类（mac.css 选择器作用域 + GlassSync 开关），
// 初始化玻璃同步（其它平台为空操作）
import { IS_MAC, initGlass } from "./lib/glass.js";
if (navigator.userAgent.includes("Macintosh") && !IS_MAC) {
  document.documentElement.classList.add("mac");
}
initGlass();

const root = createRoot(document.getElementById("app"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
