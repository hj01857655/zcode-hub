// usePageVisible — 页面可见性 hook（document.visibilityState）。
// 轮询节流用：窗口最小化/隐藏到托盘时 Tauri 主窗口 visibilitychange 会触发，
// 后台期间把 2s/5s 轮询降频到 30s（托盘常驻是本应用的常态使用方式，
// 隐藏后状态轮询没有展示价值，全速白打 IPC）。回到前台立即恢复全速并补拉一次。
import { useEffect, useState } from "react";

export function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

/**
 * 可见性感知轮询：页面可见时按 intervalMs 全速轮询；隐藏时降到 backoffMs。
 * intervalMs <= 0 = 关闸（完全不轮询，保留调用方的开关语义）。
 * fn 需自行做幂等/防重入（本仓库各轮询已是 invoke 返回后 setState，天然安全）。
 * deps 变化会重建定时器（与原生 setInterval(useEffect) 用法一致）。
 */
export function useVisiblePolling(fn, intervalMs, backoffMs, deps) {
  const visible = usePageVisible();
  useEffect(() => {
    const period = visible ? intervalMs : backoffMs;
    if (period <= 0) return undefined;
    fn();
    const id = setInterval(fn, period);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, intervalMs, backoffMs, ...(deps || [])]);
}
