# ZCode claim 完整流程（claimManualPlan）实锤文档

来源：zcode 桌面端 3.17.2 运行日志（`~/.zcode/v2/logs/2026-11-03.log`，5 次真实领取全程）+ 3.17.2 asar 解包源码（`tools/zcode-asar-3.17.2.9661/out/host/`）。记录日期 2026-11-03。本文是 `claim.rs` 全链路的权威对照。

## 1. RPC 形状（claimManualPlan）

桌面端 host 层实现（asar `out/host/index.js`，函数名 `claimManualPlan`）：

```
入参 t = { planId, captchaVerifyParam, captchaRegion? }
```

HTTP 请求：

| 项 | 值 |
|---|---|
| 端点 | `POST /api/v1/zcode-plan/billing/claim` |
| 鉴权 | `Authorization: Bearer <credentialService.load(QO)>`（**Bearer，非 x-api-key**） |
| captcha 头 | `X-Aliyun-Captcha-Verify-Param`（恒发）+ `X-Aliyun-Captcha-Verify-Region`（有 region 才发） |
| 版本头 | `X-ZCode-App-Version: 3.17.2`（桌面真实版本，**自述新版也能领取成功**） |
| 平台头 | `X-Platform: ${process.platform}-${process.arch}` = `win32-x64` |
| 载荷 | `{"plan_id": "<planId>"}` |
| 超时 | `timeoutMs: da`（模块常量） |

返回双分支：

```js
// 失败（code≠0 或无 data.plan）
{ success:false, code, message, serverTime?, failureEndsAt? }
//   failureEndsAt ← data.plan.ends_at，任意失败码都回读（不按错误码分流）

// 成功（code=0 且有 data.plan）
{ success:true, code, message:r.msg, serverTime?,
  plan: { userPlanId, planId, status, startsAt?, endsAt?,
          entitlements: [{ entitlementId, showName, effectiveAt? }] } }
```

captcha 头构造（asar `chunk-D5C6W4UB.js`，`D7` / `requestVerificationClaimHeaders`）：

```js
function D7(t) {
  return {
    "X-Aliyun-Captcha-Verify-Param": t.captchaVerifyParam,
    ...(t.captchaRegion ? { "X-Aliyun-Captcha-Verify-Region": t.captchaRegion } : {})
  };
}
```

配套常量：`$7 = "coding_plan_security_verification_required"`（服务端要求验证码的错误码）；`QD = ["X-Aliyun-Captcha-Verify-Param","X-Aliyun-Captcha-Verify-Region"]`（重试时的头白名单）。

## 1.5 preview 通道：桌面端仍在用（修正认知）

`getManualClaimPlanPreviews`（host/index.js）——桌面端手动领取 UI 的数据源之一：

```
GET /api/v1/zcode-plan/billing/preview?app_version=3.17.2&platform=win32-x64
鉴权 Authorization: Bearer <credentialService.load("zcodejwttoken")>
返回 { code, data: { server_time, plans: [{plan_id, name, description, priority, ...}] } }
```

- 凭据键 `QO = "zcodejwttoken"`（credentialService.load 的 key，claim 同源）；
- **zsw 侧「preview 恒空、已整体删除」的结论要修正**：恒空是我们在无投放环境实测的表象；桌面端手动领取 UI 把 preview 作为常驻数据源保留。zsw 刷新主路径不打 preview 仍是合理取舍（已知 429 高发端点），但它并非服务端已废弃的通道。

## 1.6 请求验证（security verification）机制

asar `chunk-D5C6W4UB.js`：

```js
var A_ = ["model-request", "captcha-retry"];   // 需要验证的场景分类
var $7 = "coding_plan_security_verification_required";  // 服务端要求验证码的错误码

function M7(t) {  // readRequestVerificationConfig：client/configs → 验证配置
  let n = t?.captcha;
  if (!n) return null;
  let { skip_model_request: r, ...i } = n;       // captcha 段字段：sceneId/region/prefix/
  return { ...i, ...typeof r === "boolean" ? { skipModelRequest: r } : {} };
}
```

重试环：请求被服务端判 `$7` → 客户端跑 captcha（预热/交互）→ 拿到 `captchaVerifyParam` → 以 `D7` 头重发原请求。`A_` 的两个场景（模型请求、captcha 重试）都受 `skip_model_request` 配置控制。

## 1.7 touch 响应完整 schema（parseMarketingTouchResponse）

```js
// 投放壳（r4，resource_position 判别联合）
{ campaign_id,                      // ← 根字段，与 resource_position 同级（我们的解析✅）
  priority,                         // int 0-100
  resource_position: "banner",      // banner 壳
    banner: { layout, background: {bundle|video|image}, buttons: ≤2, success_popup? }
  | resource_position: "popup",     // popup 壳（无 banner 前缀）
    popup: { layout, title, description, hero?, buttons: ≤4 }

// 响应包（i4）
{ code: 0, data: { server_time, language: "zh-CN"|"en-US", deliveries: ≤32 } }

// 解析（Ahe parseMarketingTouchResponse）：
//   逐条 safeParse(r4)，失败或 resource_position 重复 → 计入 rejectedCount 丢弃
//   同一 resource_position 只保留第一条（banner/popup 各一）
//   返回 { serverTime(×1000), language, deliveries, rejectedCount }

// 按钮 action 类型（e4 判别联合）
"close" | "open_url" {url} | "claim_zcode_plan" {plan_id} | "navigate" | "copy_text" {text}
```

## 2. 完整时序（2026-11-03 19:09:51 那次领取，纯日志还原）

### 阶段一：host 进程冷启动（领取前 ~11s）

每次领取起一个**全新 zcode-host 进程**（5 次领取 5 个 pid：23088/19588/10244/19048/628）——按账号隔离，凭据与网络栈互不共享。

```
T-11.1s  host 拉起
T-11.0s  billing/balance #1（hasActiveStartPlan 检查，96ms）
T-10.9s  credential.load ×2
T-10.7s  getRequestVerificationConfig（验证码配置 = client/configs 的 /data/configs/captcha）
```

### 阶段二：验证码 SDK 预热（source="prewarm"）

```
T-10.1s  AliyunCaptcha.js 装载（o.alicdn.com，442ms）
T-10.1s  init_api → [prefix].captcha-open.aliyuncs.com → 失败
T-10.0s  device_script/dynamic_js/dynamic_css（g.alicdn.com）→ 失败
         sdk.callback：instanceReady:false —— 预热未就绪，SDK 内部继续重试
T-9~T-1  device_api 重试环（五连发，双端点轮换）：
         cloudauth-device-dualstack.cn-shanghai.aliyuncs.com
         cn-shanghai.device.saf.aliyuncs.com（saf = 反欺诈）
         单次 5001ms 超时 → 换端点 → 再试；期间 balance 又轮询 2 轮
```

### 阶段三：用户点领取 → 正式验证（400ms）

```
T-0.53s  getRequestVerificationConfig（领取前再取一次）
T-0.52s  captcha attempt.start source="send_preflight"（真验证）
         stages: trigger_delay → instance_wait → verification
T-0.13s  prewarm 实例就绪（instanceReady:true，全程 10.4s）
T-0.13s  attempt.end：388ms 完成 verification，lastSdkEvent:"success"
         —— 验证码 token 到手（复用预热实例；预热 10.4s + 现场 0.4s）
```

### 阶段四：领取 + 后置链（1.5s 收尾）

```
T+0.000  claimManualPlan OK (133ms)       ← 领取本体
T+0.061  marketing-touch.report OK (60ms) ← 行为上报（见 §4）
T+0.168  marketing-touch.query OK (166ms) ← 重查投放（该号 deliveries 应已清空）
T+2.97s  billing/balance 完成：新计划现身（planCount 增长）
T+4.41s  getEntitlementSnapshot OK        ← 权益快照重建，UI 更新完毕
```

## 3. 时序要点

1. **预热-触发架构**：captcha SDK 在 host 启动时预热，正式验证复用预热实例。预热耗时 10.4s（网络差时），正式验证 388ms。`claim` 严格排在 `lastSdkEvent:"success"` 之后——验证码是硬前置；
2. **容错但非跳过**：device_api 连续失败（5001ms 超时×3、ERR_ABORTED）不阻塞——SDK 多端点轮换直到成功。阿里云侧单点失败不影响领取；
3. **一次领取全程 ≈ 4.5s**（含预热等待），纯领取动作仅 133ms；
4. **成功即记账**：balance 响应里新计划立刻出现（`planCount` 增长），无需等对账。

## 4. 后置链：marketing-touch.report（touch/action）

asar 实锤（`out/host/index.js`，`createMarketingTouchService`）：

```
POST /api/v1/marketing/touch/action
载荷 { campaign_id, action_type }
action_type ∈ ["confirm", "cancel"]    // confirm=领取，cancel=忽略投放
响应   { code: 0 }                      // zod literal 校验
超时   15s，redirect: "error"
```

- `campaign_id` 来自投放壳（touch deliveries）根字段；
- 形状为遥测埋点：失败不影响领取结果（桌面端亦然——claim 与 report 是两个独立 RPC）。

## 5. touch 查询的 seq 语义

桌面端 `marketing/touch` 的 `seq` 为**模块级递增计数器**（asar：`Xde=0, seq=String(Xde++)`，首查发 0），非固定值。zcode-switch 已对齐（`claim.rs` `TOUCH_SEQ: AtomicU64`，首查 0 递增）。

投放判定：`deliveries[].buttons[].action.type == "claim_zcode_plan"` 才是「该号当前可领」的权威信号；`preview` 通道在无投放环境实测恒空（含五个已领到的号），zsw 刷新主路径不打它——但桌面端手动领取 UI 仍以 preview 为常驻数据源（见 §1.5），两通道并存，preview 非服务端废弃。

## 6. 桌面端 vs zcode-switch 差异清单（2026-11-03 全部对齐）

| 项 | 桌面端 | zcode-switch | 状态 |
|---|---|---|---|
| 鉴权 | Bearer | Bearer（`claim_token`） | ✅ |
| captcha 头 | param 恒发 + region 条件 | 同（`submit_claim`） | ✅ |
| 版本头 | 真实版本 3.17.2 | 钉 3.16.3（SAFE，动作端点定案） | ✅ 有意差异 |
| 领取后 report | touch/action confirm | `touch_report`（`29bf710`） | ✅ 已对齐 |
| touch seq | 递增计数器 | `TOUCH_SEQ: AtomicU64`（`29bf710`） | ✅ 已对齐 |
| failureEndsAt | 任意失败码回读 ends_at | `claim_error` 无条件回读（`f1659f3`） | ✅ 已对齐 |
| captcha 预热 | host 启动即预热，全程驻留 | 每次领取开新窗冷启动 | ⚠️ 结构性差异，无痕单轮超时已放宽至 12s（`d0c5e03`） |

## 7. 风控相关实测结论（同日）

- **3012 拦截维度 = 账号是否有套餐资格**：14 号全测，10 个有套餐号全 3012、3 个裸号全 200（零例外），与版本头 / 出口 IP / body 形状无关；
- 桌面端当天自身请求零拦截（billing/claim、touch、balance 全正常）——桌面完整头族 + host 网络栈是可信形状；
- 裸号 200 空 reply = 上游接受但无额度可路由；
- 批次投放池全局共享先到先得（1103 批开放后 3 分钟内被抢空），`deliveries` 为空属池耗尽而非版本/形状问题。
