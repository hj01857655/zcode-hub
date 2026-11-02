import { zh } from "../locales/zh.js";
import { en } from "../locales/en.js";

const TABLES = { zh, en };
let LANG = "zh";

export function init(lang) {
  LANG = lang === "en" ? "en" : "zh";
  document.documentElement.lang = localeTag();
}

// 乐观切换在途时，盘上值尚未更新：轮询/刷新读到的旧语言不许覆盖 UI
let PENDING = null;
export function beginLangSync(lang) { PENDING = lang; }
export function endLangSync() { PENDING = null; }
export function langPending() { return PENDING; }
export function syncLang(lang) {
  if (PENDING != null || !lang) return;
  init(lang);
}
// 远端 state 快照在途期间带的是盘上旧语言：写入 state 前用它替换
export function patchLang(s) {
  if (PENDING != null && s) return { ...s, language: PENDING };
  return s;
}

export function lang() { return LANG; }
export function localeTag() { return LANG === "en" ? "en-US" : "zh-CN"; }

export function t(key, params) {
  const table = TABLES[LANG] || zh;
  let s = table[key] ?? zh[key];
  if (s == null) {
    console.warn("[i18n] missing key:", key);
    s = key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

export function has(key) {
  return (TABLES[LANG] || zh)[key] != null || zh[key] != null;
}

export function tn(count, oneKey, otherKey, params) {
  return t(count === 1 ? oneKey : otherKey, { ...params, count });
}

export function errCode(e) {
  const s = typeof e === "string" ? e : String(e);
  const m = s.match(/^([a-z_]+):/);
  return m ? m[1] : null;
}

export function stripErr(e) {
  const s = typeof e === "string" ? e : String(e);
  return errCode(e) ? s.replace(/^[a-z_]+:/, "") : s;
}

// 键 parity 校验：两份 locale 表键集合必须一致，漏翻在 dev 下立刻暴露（生产只 warn 一次）
{
  const zk = new Set(Object.keys(zh));
  const ek = new Set(Object.keys(en));
  const onlyZh = [...zk].filter((k) => !ek.has(k));
  const onlyEn = [...ek].filter((k) => !zk.has(k));
  const bad = [];
  if (onlyZh.length) bad.push(`仅 zh 有: ${onlyZh.join(", ")}`);
  if (onlyEn.length) bad.push(`仅 en 有: ${onlyEn.join(", ")}`);
  if (bad.length) {
    const msg = `[i18n] locale 键不一致 → ${bad.join("；")}`;
    if (import.meta.env.DEV) throw new Error(msg);
    console.warn(msg);
  }
}
