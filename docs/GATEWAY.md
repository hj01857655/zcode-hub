# GATEWAY — Rust 版 Gateway 反代设计文档

> 目标：在 zcode-hub（Tauri）内嵌 OpenAI/Anthropic 兼容反代，复用本工具现成的多号凭据体系，替代旁挂 `ZCode2api-go` 独立进程。
> 参考实现：`ZCode2api-go`（Go，~2.6k 行，协议已验证）。本文是其 Rust 翻译的设计与分解。
> 状态（2026-11-01）：M1-M3 全部落地；OpenAI 转换器已收敛到 `openai.rs` 唯一实现（translate.rs 只留 Anthropic 侧供 /v1/messages 与 /v1/responses），`server.rs` 全部挂 `openai.rs`；多号池已接线并经网关 e2e 验收（gatewayd 非流式+流式真实出话）；`src/bin/gatewayd.rs` 提供无 Tauri 的无头启动。

## 0. 一页结论

上游只有**一个端点**：`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（Anthropic messages 形态）。反代的工作 = 把 N 种客户端协议翻译成这一种，再把 SSE 回包翻译回去。鉴权、凭据、mid、身份块全部复用 zcode-switch 现有 `claim.rs`/`store.rs` 体系。

## 1. 协议矩阵

| 入站端点 | 客户端协议 | 转换器 | SSE 流式 |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions（经典） | chat → anthropic，回包反向 | data: chunks，含 `data: [DONE]` |
| `POST /v1/responses` | OpenAI Responses API（新） | `input`/`instructions`/`max_output_tokens` → anthropic | events 形态 |
| `POST /v1/messages` | Anthropic Messages（原生） | 直通（仅 system 前缀注入 + 参数钳制） | `event:`/`data:` 双行 |
| `GET /v1/models` | OpenAI Models | 静态列表：`GLM-5.3-Flash`、`GLM-5.3`（与套餐 entitlements.capabilities 一致） | — |
| `GET /health` | — | — | — |

Go 版对应物：`server.go`（路由+鉴权）、`anthropic.go`（222 行）、`responses.go`（489 行，`BuildAnthropicFromResponses`）、`translate.go`（529 行，双向转换核心）。

## 2. 架构

```
┌─ zcode-hub (Tauri) ─────────────────────────────┐
│  Webview UI ──(start/stop/status IPC)──► GatewayCtl │
│                                        │           │
│  [gateway 模块, 独立线程]                ▼           │
│   axum listener (可配端口)                        │
│    ├─ /v1/chat/completions ─┐                     │
│    ├─ /v1/responses ────────┼─► translate ───────┼──► zcode.z.ai
│    ├─ /v1/messages ─────────┘   (anthropic 形态)  │    /api/v1/zcode-plan/
│    └─ /v1/models (静态)                           │    anthropic/v1/messages
│   Bearer sk-… 鉴权；多号池：store 现成凭据          │
└────────────────────────────────────────────────────┘
```

- **进程内常驻线程**：托盘模式照常服务；窗口关闭不影响（`close_to_tray` 已有）。
- **凭据复用**：`~/.zcode-switch/accounts/*.json`（enc:v1 解密、`virtual_device_mid`）直接读，与切号共用一份真源——不引 Go 版的 `zcode_devices.json` 第二份落盘。
- **身份块**：system 前缀（seg0+seg1，来自 `prefix.json` 快照）+ `metadata.user_id` + trace 头，照抄 Go 版 `translate.go:151` 的白名单逻辑。**前缀快照跟随 ZCode 大版本重新校准**：漂移已验证（3.17.1 新前缀不被白名单认，见 §6.1），gateway 内嵌 3.16.3 主线快照，主线失效（3012）才重新提取。

## 3. 多号池（对照 Go 版 `pool.go` + `client.go:134`）

| 上游错误 | 冷却 |
|---|---|
| 401 | 30 min（token 失效） |
| 429 | 60 s（限流/额度） |
| 405 / body 含 3012 | 10 min（风控） |
| 3008/3009/3010 | 60 s（并发上限） |
| 5xx | 30 s（上游瞬断，换号重放） |
| 3007（captcha verify failed） | 60 s（已实现，upstream.rs 按 **body code** 匹配——HTTP 形态是 400+`code:3007`，不能按状态码匹配。当前靠服务端 `skip_model_request:true` 不会出现；若豁免翻 false 即确定性拒绝，60s 档防固定 JWT 无限重打。真支持则接无痕取票，见 §6.3） |
| 其他 | 0（直接返回，不换号） |

策略：失败换下一号，冷却期内跳过；全部耗尽回 503。`window_test.go` 里有窗口调度测试，Rust 版同构。

**对外状态码归一化（2026-11-08）**：客户端是 Anthropic SDK、按状态码归类重试与报错文案，`pool_send` 错误出口统一过 `server.rs external_status`——上游 200 包业务错（1005 额度耗尽）→ 429 `rate_limit_error`（透传 200 会让 Claude Code 把 error JSON 当响应体解析，表现「流提前结束」，11-02 挂账本日清）；401/403 → 503 `api_error`（上游号 token 死 ≠ 客户端鉴权失败，透传 401 会触发客户端重新登录提示）；405/3012 风控 → 529 `overloaded_error`（Anthropic 官方容量档，SDK 原生识别，客户端指数退避正好等全局退避过期）；429/400/5xx/0 语义成立透传。流中截断的 200+overloaded 合成事件与池侧 503 不变。对外 error 体（同日二补）：message 取上游 body 的 `msg`/`message` 正文（非 JSON 原样透出，body 捕获侧已限 4096 字，对外不再截），业务 `code` 随 error 对象透出（SDK 忽略未知字段），原始 body 不再整段塞进 message——`server.rs upstream_error_body` 统一出口。

**会话亲和（2026-11-01 落地）**：请求带 `x-session-id` / `x-claude-code-session-id` / `x-litellm-session-id` 头（或 body `metadata.session_id`/`metadata.user_id`）即钉同号（`pool.rs` `Sticky::Session`，独立于全局粘性开关——轮换模式下多会话照样分摊，单会话内驻留吃上游 prompt cache）。pin TTL 30 min 命中刷新，表上限 512 丢最旧一半；失败解钉换号。多客户端各自带 session 时互不冲号。

**成功率熔断（2026-11-01 落地，one-api 80%/10 同思路）**：`settle` 滚动记录每号最近 10 次收尾，错误率 ≥ 80% 即落 10 min 长冷却并清窗（覆盖单次短冷却压不住的慢性故障：3007 连发、持续 5xx）；冷却到期自动回池重新观察。前端池概览的「冷却剩余秒」直接复用，无新增展示。

**落地状态（2026-11-01）**：`pool.rs` 已实现（粘性游标 + 冷却表 + 全局退避 + 会话亲和 + 成功率熔断），`server.rs` 发送路径已接线；单测 13 项覆盖（粘性/亲和/熔断/缓存字段/SSE 聚合）。失败换号/冷却/全局退避路径未实测。

## 4. 模块分解（Rust 侧新增）

```
src-tauri/src/gateway/
  mod.rs        — GatewayCtl：启停线程、状态共享（AtomicBool + 端口/密钥配置）
  server.rs     — axum 路由 + Bearer 鉴权 + health + /v1/chat/completions、/v1/messages 接线
  translate.rs  — anthropic 直通（/v1/messages）+ anthropic 原生形态聚合（/v1/messages、/v1/responses 共用）；
                  OpenAI 转换已全部收敛到 openai.rs
  openai.rs     — OpenAI chat/completions ⇄ anthropic 唯一实现：tool_calls/视觉(data:image)/tool_result、
                  Delta 流式语义（translate_sse_line）+ 非流式聚合（aggregate_sse_to_openai）+ 流式装配器（OpenAiStream）
  pool.rs       — 多号轮询 + 冷却 + 全局退避（读 store 凭据，已接线 server.rs）
  bin/gatewayd.rs — 无头启动入口：读 gateway.json（ZCODE_GATEWAY_PORT / ZCODE_GATEWAY_API_KEY 可覆盖），
                  不起 Tauri 直接 serve（e2e 验收 / 服务器部署用）
  upstream.rs   — z.ai messages 客户端（reqwest，非流式聚合 + bytes_stream 流式；冷却表）
```

依赖新增：`axum`（或 tiny-http + 手路由）、`tokio`（Tauri 已带）、`reqwest` stream。IPC 命令：`gateway_start` / `gateway_stop` / `gateway_status`，配置落 `~/.zcode-switch/gateway.json`（端口、sk-… 密钥）。

## 4b. 前端设计（现状：`views/gateway.jsx` + `views/gateway-logs.jsx`，均已落地）

网关页（`gateway.jsx`）自上而下：

1. **品牌行**：`Gateway` 大字 mono + 状态徽标（`已停止` 灰 / `运行中` mint 绿）；`gateway_status` 1s 轮询（running/port/uptime/requests_total/errors_total/pool）
2. **端点块**：Base URL（一键复制）+ API 密钥（打码显示 + 复制），多账号池概览（每号名称 + 状态点 + 今日请求数 + 冷却剩余秒）
3. **操作行**：启动/停止互斥按钮、`配置` 调优弹窗（tuneOpen 内联：端口/密钥/池参数/冷却参数，未运行才可改）、`冒烟测试` 弹窗（渠道测试/Playground 形态：协议切换 OpenAI `/v1/chat/completions` / Anthropic `/v1/messages`、System 输入框（OpenAI 走消息数组首位、Anthropic 走顶层 system）、消息、max_tokens/temperature/top_p 参数行、流式开关、动态 curl 预览（按当前表单生成，密钥打码）、结果面板（HTTP/耗时/流式标记/token 用量双协议归一 `out↑/in↓`）、近 5 次历史）
4. **请求日志**：独立日志页 `views/gateway-logs.jsx`（网关页 `打开日志` 入口）；顶部统计卡三组：请求（总数/成功/失败/成功率）、延迟（端到端 p50/p95 + 流式 TTFT p50/p95，分位数口径不用均值——业界惯例，均值被长尾拉偏）、TOKENS（输入↓/输出↑/缓存⚡），随筛选联动；表格列 = 时间/模型/账号/状态/耗时（流式显示 TTFT/总耗时），行首 chevron 展开指示器（折叠朝右/展开旋转 90° 朝下），行展开为 LogBlock 单一实现，响应侧支持原文/JSON/正文/SSE（sseFlat 拍平）四种格式切换；支持筛选（端点/状态/搜索）与 JSON 导出；日志落盘开关在日志页
- 样式：Tailwind v4（`src/tailwind.css` `@theme`）+ 主题变量；文案全部 `x.*` i18n 键（zh/en 同步，`yarn check:i18n` 门禁）

## 5. 里程碑（每步可独立验证）

| # | 内容 | 验证 |
|---|---|---|
| M1 | 服务骨架：axum 起停 + `/v1/models` 静态列表 + Bearer 鉴权 + UI 按钮接线 | ✅ 已验（curl 401/200） |
| M2 | Anthropic messages 非流式：直通 + 前缀注入，真实出话 | ✅ 已验（Python 同构 200 出话） |
| M3 | OpenAI chat/completions 非流式 + 流式 SSE | ✅ 已验（多轮出 "5"、流式 42 chunk 出 "收到"） |
| M4 | /v1/responses + /v1/messages SSE 透传 + pool.rs 多号农场 | ✅ 已落（编译绿；/v1/chat/completions 已整链验收，messages 直通与 responses 未经 axum 整链实测） |
| M5 | 面板请求日志/池可视化/调优与测试弹窗/独立日志页 | ✅ 已落（`gateway.jsx` + `gateway-logs.jsx`；vite build 绿） |

## 6. 风险与前置

1. **前缀快照漂移（✅ 已验证 + 已定性，2026-10-31）**：3.16.3 → 3.17.1 system 前缀漂移实锤（2 段 2355c → 3 段 4799c，seg0 措辞变、seg1 重写、新增 seg2）。但**服务端白名单不认 3.17.1 新前缀**——实测对照：主线前缀（2 段 2355c）200 出话；3.17.1 新提取前缀 405/3012。**结论：白名单仍锚定 3.16.3 主线，gateway 内嵌主线前缀**（`src-tauri/src/gateway/assets/prefix.json`）。主线失效（3012）才需要重新校准，勿提前换新前缀。
2. **SSE 转换正确性**：三种客户端方言的流式事件差异（`[DONE]` vs events vs message_stop），需逐客户端实测。
3. **验证码管道存在、当前豁免（2026-10-31 反编译+实测定案）**：官方客户端在 start-plan 模式（`access.type===zhipu-account && access.mode===start-plan`）下，每次模型请求前会按 `client/configs` 的 `captcha` 配置解无痕验证码，把 `X-Aliyun-Captcha-Verify-Param/-Region` 作为 runtime headers 附到 messages 请求上（`send_preflight` 主动 + `captcha-retry` 被挑战后重试两源）。但当前服务端配置 `skip_model_request: true`（2026-10-31 实拉 client/configs），LOt 走豁免分支返回空 headers——今天的 chat 就是 Bearer + 版本头裸打。该豁免是服务端一行遥控配置：反代侧留一个探测点，定期拉 `client/configs` 读 `captcha.skip_model_request`，翻 false 时报警（届时接入 captcha_solve.js 同款无痕取票逻辑挂进 messages 头——取票参数与 claim 同一套：prefix `no8xfe`、region `cn`、sceneId `11xygtvd`，票值塞进 `X-Aliyun-Captcha-Verify-Param` + `X-Aliyun-Captcha-Region: cn`，挂点在 `upstream::headers()`）。在那之前：429/3012 不验证码，靠池冷却规避；出现 3007 类交互要求直接回错误（冷却表已有 3007→60s 兜底，见 §3）。
4. **Tauri 常驻线程与打包**：axum 在 Tauri runtime 里跑 tokio，注意端口占用冲突检测（与 dev 的 5173、zclaim 的 7861 错开）。
5. **头集最终形态（版本闸定案，2026-11-01）**：messages 头集 = **整套官方头族，版本钉死 3.16.3**（`upstream.rs SAFE_APP_VERSION`，`ZCODE_GATEWAY_APP_VERSION` 可覆盖做归因实验）。`User-Agent` 与 `X-ZCode-App-Version` 自报 3.17.1 回 3012/405（均单条实锤），自报 3.14.0/3.16.3 均 200——全头族（UA+版本族+Referer/Title+X-Device-Mid+x-request-id+anthropic-version）钉 3.16.3 → 200；其余 13 条头逐组/单发验证均 200。claim/billing/touch 通道相反，要求 3.17.1 真实版本头（见 [APP-VERSION.md](APP-VERSION.md)）。
   - 与 body 的代际自洽：主线前缀白名单同样锚定 3.16.3（见第 1 条），头版本 3.16.3 + 主线前缀是同一代际组合。
   - 自动降级闩（`upstream.rs note_risk_response`）：SAFE 自述撞 405/3012 时进程内锁存切 3.14.0（该自述单头实测 200 档），下一发请求生效、失败那发不重试；`ZCODE_GATEWAY_APP_VERSION` 手动钉版本时闩不介入，不自动回升。
   - `cache_control` 与 `metadata.user_id` JSON 串形状各形态均被接受，保留。ⓘ chat/completions 已经 axum 整链验收（gatewayd，2026-11-01，非流式+流式真实出话）；messages 直通与 responses 的整链实测待补。

   **归因时间线（2026-10-31 → 11-01，实测记录）**：
   - M3-E（10-31）：仅 `Authorization: Bearer` + `Content-Type` 两条头、system 无 `cache_control`、`metadata.user_id` JSON 内嵌串——真实 200 出话。
   - 全头族（`ZCode/3.17.1` UA + 版本头族 + `X-Device-Mid`）+ 主线前缀带 `cache_control` → 405/3012（10-31 23:5x，`scripts/farm_probe.py`）。
   - 逐组 bisect（11-01，`scripts/header_bisect.py` + `version_family_bisect.py`）：薄头基线 → 200；叠加 `UA:ZCode/3.17.1` 单条 → 3012；无 UA 叠版本头族 → 3012；`HTTP-Referer`/`X-Title`、`X-Device-Mid`、`x-request-id`、`anthropic-version` 逐组叠加全 200；族内二分定位 `X-ZCode-App-Version` 单条 → 3012；薄头+族内其余 6 条 → 200。
   - 版本豁免档（11-01）：`UA:ZCode/3.14.0`、`X-ZCode-App-Version: 3.14.0` 各一发 200；全头族钉 3.16.3 → 200（同轮薄头对照 200）。
