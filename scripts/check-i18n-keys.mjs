#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDict(f) {
  const src = readFileSync(join(root, "src/locales", f), "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/^\s*"([^"]+)"\s*:/gm)) keys.add(m[1]);
  return keys;
}

const zh = loadDict("zh.js");
const en = loadDict("en.js");

const errs = [];
for (const k of zh) if (!en.has(k)) errs.push(`en 缺 key: ${k}`);
for (const k of en) if (!zh.has(k)) errs.push(`zh 缺 key: ${k}`);

const DYNAMIC = [
  "q.win.daily", "q.win.weekly", "q.win.monthly", "q.win.cycle",
  "prov.bigmodel", "prov.zai",
  "m.bitVerifyNoPlan", "m.bitVerifyAuthFailed",
  "r.task.login_device", "r.task.referral_bind_code",
  "r.task.referral_new_user_reward", "r.task.send_message",
];

const callRe = /\bt\(\s*(["'])((?:(?!\1).)+)\1/g; // 只匹配引号串；模板串走 DYNAMIC
// 递归扫 .js/.jsx：绝大多数视图是 src/views/*.jsx 与 src/components/*.jsx，
// 只扫 src 顶层会让 check:i18n 在缺键时照样报绿
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.(js|jsx)$/.test(e.name) ? [p] : [];
  });
}
for (const p of sources(join(root, "src"))) {
  const f = p.slice(root.length + 1);
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(callRe)) {
    const key = m[2];
    // 前缀拼接（t("r.task." + k)）：只要词表里存在以该前缀开头的键即视为覆盖
    const prefixed = key.endsWith(".") && [...zh].some((k) => k.startsWith(key)) && [...en].some((k) => k.startsWith(key));
    if (!prefixed && (!zh.has(key) || !en.has(key))) errs.push(`${f}: 用了未定义 key: ${key}`);
  }
}
for (const k of DYNAMIC) {
  if (!zh.has(k) || !en.has(k)) errs.push(`动态家族缺 key: ${k}`);
}

if (errs.length) {
  console.error("✗ i18n key 检查失败:\n  " + errs.join("\n  "));
  process.exit(1);
}
console.log(`✓ i18n keys OK（zh/en 各 ${zh.size} 个，静态调用点 + 动态家族全覆盖）`);
