// GlassPane — 玻璃面板挂载点（React ref 注册制，上游 data-glass DOM 扫描的 React 对应物）。
// 挂载时把 DOM 节点注册进 glass.js 的注册表（ResizeObserver 观察几何），卸载即注销；
// 非 mac 平台 render 透传 children，注册函数内部为空操作。
// source="desktop"：底色层在此镂空、玻璃取样桌面；缺省取样窗口底色。
import { useEffect, useRef } from "react";
import { registerPane, unregisterPane } from "../lib/glass.js";

export function GlassPane({ id, source, className, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) registerPane(id, ref.current);
    return () => unregisterPane(id);
  }, [id]);
  return (
    <div ref={ref} data-glass={id} data-glass-source={source} className={className}>
      {children}
    </div>
  );
}
