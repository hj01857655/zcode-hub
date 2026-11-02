
const P = (d) => `<path d="${d}"/>`;

const ICONS = {
  gauge: P("M2.5 12.5h11") + P("M3.6 12.5a4.4 4.4 0 0 1 8.8 0") + P("M8 12.5 10.8 8.2"),

  pen: P("M2.5 13.5l.9-3.3 7.6-7.6 2.4 2.4-7.6 7.6z") + P("M9.9 4.9l2.4 2.4"),

  export: P("M8 9V2") + P("M5.2 4.8 8 2l2.8 2.8") + P("M2.5 10.5v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"),

  import: P("M8 2v7") + P("M5.2 6.2 8 9l2.8-2.8") + P("M2.5 10.5v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"),

  exportAll: P("M2.5 13.5h11") + P("M4.5 11h7") + P("M8 2v6") + P("M5.5 5.5 8 8l2.5-2.5"),

  x: P("M3.5 3.5l9 9") + P("M12.5 3.5l-9 9"),

  swap: P("M2.5 5.5h9.5") + P("M9.5 3 12 5.5 9.5 8") + P("M13.5 10.5H4") + P("M6.5 8 4 10.5 6.5 13"),

  capture: P("M3 2.5h10") + P("M8 5.2v5.8") + P("M5.5 8.5 8 11l2.5-2.5") + P("M3 13.5h10"),

  gift: P("M2.5 6.5h11") + `<rect x="3.5" y="8" width="9" height="5.5"/>` + P("M8 6.5v7") + P("M8 6.5 6 4.6") + P("M8 6.5 10 4.6"),

  refresh: P("M13.5 8a5.5 5.5 0 1 1-1.6-3.9") + P("M13.5 2.5V6.5h-4"),

  userPlus: P("M6 6.8a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6") + P("M2 13.5v-.9a4 4 0 0 1 8 0v.9") + P("M12 5.5v4") + P("M10 7.5h4"),

  play: `<path d="M5 3.2v9.6l8.2-4.8z" fill="currentColor" stroke="none"/>`,

  power: P("M8 2v5.5") + P("M4.6 4.3a5 5 0 1 0 6.8 0"),

  sliders: P("M2 4.5h12") + P("M2 11.5h12") + `<rect x="8.5" y="2.5" width="4" height="4"/>` + `<rect x="3.5" y="9.5" width="4" height="4"/>`,

  lock: `<rect x="3.5" y="7.2" width="9" height="6.3"/>` + P("M5.5 7.2V5a2.5 2.5 0 0 1 5 0v2.2") + P("M8 9.7v1.8"),

  lockOpen: `<rect x="3.5" y="7.2" width="9" height="6.3"/>` + P("M5.5 7.2V5a2.5 2.5 0 0 1 4.9-.6") + P("M8 9.7v1.8"),

  check: P("M3 8.6l3.3 3.2L13 4.6"),
  alert: P("M8 2.2 14.8 13.8H1.2z") + P("M8 6.4v3.2") + P("M8 11.6v.2"),

  empty: P("M3 3h10") + P("M3 13h10") + `<path d="M8 6.2v3.6M6.2 8h3.6" stroke-dasharray="2 1.6"/>`,

  // 侧边导航用
  list: P("M3 4.2h10") + P("M3 8h10") + P("M3 11.8h5.5"),

  // 邀请/推荐链接
  link: P("M6.5 9.5a3 3 0 0 1 0-4.2l1.4-1.4a3 3 0 0 1 4.2 4.2l-.9.9") + P("M9.5 6.5a3 3 0 0 1 0 4.2l-1.4 1.4a3 3 0 0 1-4.2-4.2l.9-.9"),

  // 主题切换
  sun: `<circle cx="8" cy="8" r="3.1"/>` + P("M8 1.4v1.8") + P("M8 12.8v1.8") + P("M1.4 8h1.8") + P("M12.8 8h1.8") + P("M3.5 3.5l1.3 1.3") + P("M11.2 11.2l1.3 1.3") + P("M12.5 3.5l-1.3 1.3") + P("M4.8 11.2l-1.3 1.3"),
  moon: P("M13.3 9.3A5.8 5.8 0 0 1 6.7 2.7a5.8 5.8 0 1 0 6.6 6.6z"),

  // 日志 token 徽章：tokIn=输入(↓ 进入模型)，tokOut=输出(↑ 流出模型)，与行内 tout↑/tin↓ 同向
  tokIn: P("M8 2.5v7") + P("M5 6.5 8 9.5l3-3") + P("M3 13h10"),
  tokOut: P("M8 9.5v-7") + P("M5 5.5 8 2.5l3 3") + P("M3 13h10"),
  bolt: P("M9.2 1.8 3.8 9.2h3.4l-.9 5 5.9-7h-3.4z"),
  clock: `<circle cx="8" cy="8" r="5.6"/>` + P("M8 4.8V8l2.2 1.6"),

  // 网关页：endpoint 复制、key 显隐
  copy: `<rect x="5.5" y="5.5" width="8" height="8"/>` + P("M3.5 10.5h-1v-8h8v1"),
  eye: P("M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8z") + `<circle cx="8" cy="8" r="1.8"/>`,
  eyeOff: P("M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8z") + `<circle cx="8" cy="8" r="1.8"/>` + P("M2.5 2.5l11 11"),
};

export function ic(name, size = 16, cls = "") {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="ic${cls ? " " + cls : ""}" width="${size}" height="${size}" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;
}

// React 渲染层用：只取 path 体，由 <Ic> 组件包 svg
export function iconBody(name) {
  return ICONS[name] || "";
}
