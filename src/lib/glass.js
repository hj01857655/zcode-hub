// React 版 macOS 原生玻璃同步：GlassPane 组件 ref 注册制（上游 glass.js 的
// data-glass + MutationObserver 全量扫描在 React 下是反模式——卸载即注销，
// 无需全量扫描）。
// 玻璃在 WKWebView 下方，因此面板元素自身及上方各层不能绘制底色；底色由
// 原生底色层提供（--glass-base）。其它平台为空操作。
import { invoke } from "@tauri-apps/api/core";
import { currentTheme } from "./theme.js";

export const IS_MAC = document.documentElement.classList.contains("mac");

const panes = new Map(); // id -> { el, observed }
let queued = false;
let last = "";
let ro = null;

function collect() {
  const list = [];
  for (const [id, entry] of panes) {
    const el = entry.el;
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    list.push({
      id,
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      source: el.dataset.glassSource || "base",
    });
  }
  // dark 跟应用主题走（theme.js 的 data-theme），不是系统 prefers-color-scheme——
  // 手动切主题时玻璃底色必须同步，否则原生层与网页层配色脱节
  const dark = currentTheme() !== "light";
  const root = getComputedStyle(document.documentElement);
  const base = root.getPropertyValue("--glass-base").trim() || (dark ? "#0a0a0c" : "#efeff2");
  return { panes: list, base, dark };
}

function flush() {
  queued = false;
  const frame = collect();
  const key = JSON.stringify(frame);
  if (key === last) return;
  last = key;
  invoke("glass_sync", { frame }).catch(() => { last = ""; });
}

// 不用 requestAnimationFrame：窗口被完全遮挡时 WebKit 暂停 rAF，玻璃几何会停在旧帧；
// getBoundingClientRect 同步完成布局，一个宏任务合并同轮多次触发
export function syncGlass() {
  if (!IS_MAC || queued) return;
  queued = true;
  setTimeout(flush, 0);
}

function observeEntry(entry) {
  if (!ro || entry.observed) return;
  ro.observe(entry.el);
  entry.observed = true;
}

export function registerPane(id, el) {
  if (!IS_MAC) return;
  panes.set(id, { el, observed: false });
  if (!ro) {
    ro = new ResizeObserver(syncGlass);
  }
  observeEntry(panes.get(id));
  syncGlass();
}

export function unregisterPane(id) {
  if (!IS_MAC) return;
  const entry = panes.get(id);
  if (entry?.observed) ro?.unobserve(entry.el);
  panes.delete(id);
  syncGlass();
}

// 主题切换时玻璃底色要重提一帧（base/dark 变化），zcs-theme 事件驱动
export function initGlass() {
  if (!IS_MAC) return;
  window.addEventListener("zcs-theme", () => {
    last = "";
    syncGlass();
  });
  window.addEventListener("resize", syncGlass);
  syncGlass();
}
