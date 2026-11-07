// LogBlock — 请求/响应体折叠查看组件（自 gateway-logs.jsx 抽出共享）。
// 原文 / JSON / 正文 / SSE 四视图切换；req/resp 落盘时可能被截断（8K/16K cap），
// 能解析就美化，不能就原样。系统日志页与请求日志页共用。
import { useMemo, useState } from "react";
import { t } from "../lib/i18n.js";

// req/resp 落盘时可能被截断：能解析就美化，不能就原样
export const prettyJson = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
// 正文提取：只留人读的回答文本。双协议双通道都认：
// OpenAI（delta.content / message.content / reasoning_content）、Anthropic（delta.text / delta.thinking / content[0].text）。
// 有思考流时前置思考段（max_tokens 截断场景常见「只有思考没有回答」），空结果回退原样不吞内容
export const fmtText = (s) => {
  if (!s) return "";
  const t0 = String(s).trim();
  if (t0.startsWith("data:") || t0.includes("\ndata:")) {
    let out = "";
    let think = "";
    for (const line of t0.split("\n")) {
      const d = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!d || d === "[DONE]") continue;
      try {
        const v = JSON.parse(d);
        const ch = v?.choices?.[0];
        out += ch?.delta?.content ?? v?.delta?.text ?? "";
        think += ch?.delta?.reasoning_content ?? v?.delta?.thinking ?? "";
      } catch { /* 非 JSON 帧跳过 */ }
    }
    if (out || think) return (think ? `${t("x.fmtThink")}\n${think}\n\n${t("x.fmtAnswer")}\n` : "") + out;
  }
  try {
    const v = JSON.parse(t0);
    const content = v?.choices?.[0]?.message?.content ?? v?.content?.[0]?.text ?? "";
    const think = v?.choices?.[0]?.message?.reasoning_content ?? "";
    return (think ? `${t("x.fmtThink")}\n${think}\n\n${t("x.fmtAnswer")}\n` : "") + content;
  } catch { return s; }
};

// SSE 流美化：与原文同一帧序列，只把每帧压缩的 data: JSON 展开成多行（帧间空行），
// event:/[DONE]/非 JSON 行原样保留——就是 SSE 正常格式的可读版，不做任何摘要
export const sseFlat = (s) => {
  const out = [];
  for (const l of String(s).split("\n")) {
    const t = l.trimEnd();
    if (t.startsWith("data: ")) {
      const d = t.slice(6).trim();
      if (d !== "[DONE]") {
        try { out.push("data: " + JSON.stringify(JSON.parse(d), null, 2)); continue; } catch { /* 非 JSON 帧原样 */ }
      }
      out.push(t);
    } else if (t) {
      out.push(t);
    }
  }
  return out.join("\n\n");
};

// 请求/响应块：原文 / JSON / 正文 / SSE 四视图切换（req 无正文档；SSE 档把事件流拆成可读行），复制按钮复制当前视图
export function LogBlock({ label, raw, resp }) {
  const isJson = useMemo(() => { try { JSON.parse(String(raw).trim()); return true; } catch { return false; } }, [raw]);
  const isSse = useMemo(() => /^\s*event:|^\s*data: /m.test(String(raw)), [raw]);
  // 默认档：能解析就用 JSON，否则落原文
  const [fmt, setFmt] = useState(isJson ? "json" : "raw");
  const opts = [
    ["raw", t("x.fmtRaw")],
    ...(isJson ? [["json", "JSON"]] : []),
    ...(resp ? [["text", t("x.fmtText")]] : []),
    ...(isSse ? [["sse", t("x.fmtSse")]] : []),
  ];
  const view = fmt === "json" ? prettyJson(raw) : fmt === "text" ? fmtText(raw) : fmt === "sse" ? sseFlat(raw) : String(raw);
  return (
    <div className="x-log-block">
      <div className="x-log-block-head">
        <span>{label}</span>
        <span className="x-fmt-seg">
          {opts.map(([k, lab]) => (
            <button key={k} className={fmt === k ? "on" : ""}
              onClick={(e) => { e.stopPropagation(); setFmt(k); }}>{lab}</button>
          ))}
        </span>
        <button className="btn-ghost x-log-copy"
          onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(view).catch(() => {}); }}>
          {t("x.copyBtn")}
        </button>
      </div>
      <pre className={"x-log-pre" + (fmt === "text" ? " x-log-pre-text" : "")}>{view}</pre>
    </div>
  );
}
