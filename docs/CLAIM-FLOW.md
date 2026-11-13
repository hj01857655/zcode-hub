# ZCode claim 完整流程（claimManualPlan）实锤文档

来源：zcode 桌面端 3.17.2 运行日志（`~/.zcode/v2/logs/2026-11-03.log`，5 次真实领取全程）+ 3.17.2 asar 解包源码（`tools/zcode-asar-3.17.2.9661/out/host/`）。记录日期 2026-11-03。

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
| 超时 | 15s（模块常量 `da=15e3`） |

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

配套常量：`$7 = "coding_plan_security_verification_required"`（服务端要求验证码的错误码）；`QD = ["X-Aliyun-Captcha-Verify-Param","X-Aliyun-Captcha-Verify-Region"]`（重试时的头白名单）。凭据键 `QO = "zcodejwttoken"`。

## 1.5 preview 通道：注册但今日零调用

`getManualClaimPlanPreviews`（host/index.js）在 asar 里注册了完整实现：

```
GET /api/v1/zcode-plan/billing/preview?app_version=3.17.2&platform=win32-x64
鉴权 Authorization: Bearer <credentialService.load(QO)>
返回 { code, data: { server_time, plans: [{plan_id, name, description, priority, ...}] } }
```

**但 2026-11-03 全天日志实测：RPC 0 次调用、`billing/preview` HTTP 0 次出现**——5 次真实领取全程（19:08–19:11）都没有走它。`coding-plan-subscription.*` 当天全量 RPC 清单：getEnterprisePricing ×127、getStaticTeamProducts ×84、getBillingDiscount ×30、getDynamicWorkflowClientConfig ×27、getStaticProducts ×18、getRequestVerificationConfig ×12、claimManualPlan ×5——**无 preview**。

结论：handler 注册 ≠ 实际调用。桌面端领取链路的前置数据源**唯一是 touch.query**；preview 注册在那属于某个当日未触发的 UI 面。

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
{ campaign_id,                      // ← 根字段，与 resource_position 同级
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

## 5. touch 查询的形状与 seq 语义

请求（桌面端完整形状）：

```
GET /api/v1/marketing/touch?seq=<递增计数器，首查 0>
头：X-Device-Mid + X-Client-Language + X-ZCode-App-Version + Authorization Bearer
URL 仅带 seq；版本/平台只在头里
身份守卫：响应后重取 context 比对 scope，变更则抛 marketing_identity_changed
```

- `seq` 为**模块级递增计数器**（asar：`Xde=0, seq=String(Xde++)`，首查发 0），非固定值；
- 投放判定：`deliveries[].buttons[].action.type == "claim_zcode_plan"` 才是「该号当前可领」的权威信号；
- 查询上下文（asar `createMarketingTouchService` 的 `r(o)`）：每请求前解析 token/deviceMid/locale 组装头，token 或 mid 变化即重建 scope。

## 6. 风控相关实测结论（同日）

- **3012 拦截维度 = 账号是否有套餐资格**：14 号全测，10 个有套餐号全 3012、3 个裸号全 200（零例外），与版本头 / 出口 IP / body 形状无关；
- 桌面端当天自身请求零拦截（billing/claim、touch、balance 全正常）——桌面完整头族 + host 网络栈是可信形状；
- 裸号 200 空 reply = 上游接受但无额度可路由；
- 批次投放池全局共享先到先得（1103 批开放后 3 分钟内被抢空），`deliveries` 为空属池耗尽而非版本/形状问题。

## 7. 完整链路总图（端到端）

```
① 发现可领（touch 轮询，稳态 ~2 次/小时）
   GET /api/v1/marketing/touch?seq=<递增，首查 0>
   头：X-Device-Mid + X-Client-Language + X-ZCode-App-Version + Authorization Bearer
   URL 仅带 seq；版本/平台只在头里
   响应 ≤32 deliveries，parse 按 resource_position 去重（banner/popup 各保留一条）
   可领判定：buttons[].action.type == "claim_zcode_plan"（args.plan_id）

② 领取入口
   getRequestVerificationConfig → GET /api/v1/client/configs → data.configs.captcha
   形状：{ enabled, sceneId, region, prefix, skip_model_request? }

③ 验证码（硬前置，claim 严格排在 lastSdkEvent:"success" 之后）
   预热：host 启动即装载 SDK（实测 10.4s 就绪），正式验证复用预热实例（388ms）
   失败重试环：device_api 双端点轮换（cloudauth-device-dualstack / device.saf），
   单点失败不阻塞；产物 captchaVerifyParam

④ claim 本体（133ms 实测）
   POST /api/v1/zcode-plan/billing/claim
   头：Authorization Bearer + X-Aliyun-Captcha-Verify-Param（恒发）
       + X-Aliyun-Captcha-Verify-Region（条件）+ X-ZCode-App-Version + X-Platform
   载荷 {"plan_id"}；超时 15s（da=15e3）

⑤ 后置链
   成功：POST /marketing/touch/action {campaign_id, action_type:"confirm"}
        → touch.query（确认投放清空）→ billing/balance → getEntitlementSnapshot
   失败：任意码回读 data.plan.ends_at → failureEndsAt（冷却展示）
        被判 security_verification_required → 回到 ③ 重试

⑥ 错误码族
   401（无凭据）/ 1001–1005（业务态，1005=计划期内重复领取）/ 3001、3007 / -1（网络/解析）
   服务器 msg 优先展示
```

## 8. 失败分支逆向：领取失败不撤销资格（2026-11-11 asar 实凿）

UI 层 dialogAction（`app.asar` @ ~370389500–370393500，3.18.0.10300）失败路径逐行：

```js
if (s.status !== `success`)
  return (i.type===`claim_zcode_plan`||i.type===`open_url`)
         && (s.terminal||s.status===`uncertain`) && (a=!0, m()),   // 终局/不确定 → 本地关弹窗
         t.setState({error:s.message??null, errorAction:i.type}), s;
// finally: a=true 时 banner 置 null；o(=成功标记) 为 false → 不调 e.refresh()
```

服务层 claimManualPlan（`app.asar` @ ~319768306）失败返回：

```js
if (s!==0 || !r.data?.plan) {
  let d = r.data?.plan?.ends_at;
  return {success:!1, code:s, message:r.data?.message??"",
          ...Number.isFinite(d) ? {failureEndsAt:d} : {}}   // 唯一附带字段
}
```

**结论：客户端失败分支零权益操作**——不调 balance、不调 entitlement、不发 touch/action
（confirm 只在成功、cancel 只在手动关闭时发）。所谓"撤销"只有两条假象：

1. **弹窗被消费**：terminal/uncertain 失败时本地把 banner/dialog 置 null 且不 report——
   投放入口在 UI 消失，但服务端投放记录未收到任何消耗信号，下次 touch.query 可能重投；
2. **failureEndsAt 冷却展示**：`data.plan.ends_at` 仅用于 1005（计划期内重复领取）时
   的"有效期至 X"倒计时——不是撤销，是"当前 plan 期内不能再领"的服务端事实回显。

资格真实约束 = 服务端 plan 记录（1005 证明"每计划期一次"由服务端记账，与客户端成败展示无关）。
成功路径才动权益：confirm report → 投放清空 → balance 新 plan → entitlement 快照重建。

## 9. 投放侧闸门：批量"不可领取"的真因（2026-11-12 实测）

14 号农场当天全部有资格（15 条 touch 全 `deliveries=1 plans=zcode-v3-start-plan-1112`），
依次领取 5 个（billing/claim 全 code=0）后，第 6 个起 9 条 touch 全 `deliveries=0`，
且后续 19:07/19:09/19:17 三批复查仍全空。全天无一笔失败 claim——
后 9 号根本没收到投放，`billing/claim` 一次都没发出。客户端"不可领取"是空投放的展示层回声。

单变量实验排除两个维度（touch 为 GET 轮询，无副作用）：

| 变量 | 实验 | 结果 |
|------|------|------|
| 设备 mid | 未领号 own-mid / fake-mid（同格式 uuid） | 均 deliveries=0，无差别 |
| 缺 mid | 未领号不发 X-Device-Mid | HTTP 400 code=3001（mid 必填，反证服务端在读它） |
| 出口 IP | 未领号走 10 个独立住宅代理出口 | 代理厂商隧道层全 429（池当日配额耗尽），未能实测 |

已实锤的因果：**投放配额按（环境 × 时间窗）计——每窗 5 份先到先得，窗口 ≈2h07m 滚动重开、
按天重置，波次只在晚间开（11/12 定案，11/13 通宵复核坐实）**：

- 每天首波前 14 号全有资格（11/12 探测全 deliveries=1）——配额随日期重置；
- 领满 5 收闸：未领号的"资格"被投放层挡住（touch deliveries=0），非 claim 层拒绝；
- **窗口滚动实证（21:07:20–21:07:45，hub 自动领 5 笔全 code=0）**：1292548381/hjj09903/
  ShannonYoung8131/AaronWallace42/NazSuno19142——恰为第一波未领的 5 号，间隔距首波
  **127.1 min**（预测 126.5，差 0.6 min）；第二波投放流向未领池（按「该计划未领」过滤）；
- 11/10 两小批（19:45 两笔 / 19:57 三笔，间隔 11.5 min）兼容"每窗 5"：首窗仅耗 2，
  余 3 名额继续可发，不必等窗口滚动；
- 19:00 领满后 +84.4 min（20:25）复查仍空：闭窗期。22:14/22:15 复查 9 号 deliveries 全 0：
  其中 5 号 21:07 已领走（deliveries 随领取清空），另 4 号（yrs1rgxk/so2j0pwh/
  RobertoSantos6003/BrettCarter1531）本波未获投放——投放队列只发了 5 份，未见者等下一窗。
  22:14 John 目击的"10 个"= hub UI 今日已领账号数（5+5）。
- **wave2 连续两天流向同 5 号（11/11、11/12 均为 1292548381/hjj09903/ShannonYoung8131/AaronWallace42/
  NazSuno19142）**：服务端存在外部不可见的账号级优先序，farm 号是二等公民——投放目标不按
  「未领优先补」，配额与覆盖全部账号脱钩；凑满 14/14 需连续三波全撒未领者，现行发法不可达，
  **10/14 即日天花板**。
- **通宵复核（11/13 08:39–08:53）**：claim-history 末笔仍为 11/12 21:07:45，此后整夜零新增——
  按 127 分钟滚动预测的 wave3（~23:14）整夜未出现：**日上限 10 一领满即停发**，当日不再开新窗，
  11/13 上午 plan-1113 未投放。四天首波时刻 19:08 / 19:45 / 20:13 / 19:00，从无上午或午夜后波，
  次日首波预计 ~19:00 重新开放（yrs1rgxk/so2j0pwh/RobertoSantos6003/BrettCarter1531 等待当日波次）。

**收割策略（11/13 修订）**：按波次走——晚间首波 ~19:00，约 127 分钟后可选第二波，日上限 10、共 1~2 波
（「一天 3~4 波覆盖 14 号」作废）；必须赶在窗口开着时领（投放存续期短，22:14→22:15 一分钟内
10 个可见位全部消失）。与 §8 闭环：资格撤销不存在，闸门在投放侧；1005 才是账号级重复领取的回声。

待验证（优先级降后）：① 投放存续期精确时长（下轮窗口开时 30s 级密集轮询 touch）；② 换出口
IP 是否立即恢复投放（代理池 429 未测成）——若兑现则窗口模型可叠加 IP 维度多开并行。
绕行思路已预留：claim.rs scoped_agent per-account scope 接线。

## 10. claim 端点直证：投放空=无法领取，码闸在前（2026-11-12 补）

对无投放账号直接 POST billing/claim（plan-1112），闸门顺序与资格判定全部实锤：

**闸门顺序**：
- 裸打（无 captcha 头）→ HTTP 400 `code=3007 captcha verify failed`——验证码闸在最前；
- 降级票（探针页缺 `prefix` → SDK 请求全打 `undefined.captcha-open.aliyuncs.com`，
  INIT_FAIL，产 76B `isSign` 短票）→ 仍 3007：服务端查不到 certifyId 完成记录；
- 补 `prefix=no8xfe + region=cn`（client/configs 的 captcha 段）→ 280B `securityToken`
  真票，无痕首轮即成，3007 消失。

**真票三对照**（同票、同头族、同出口 IP，仅账号状态不同）：

| 账号状态 | 响应 |
|---|---|
| 旅行者3007（今日已领 plan-1112） | HTTP 200 `code=1003 target already exists`（业务层） |
| AaronWallace42（昨日领 1111 已到期，今日无投放） | HTTP 405 `code=3012 账号或者网络环境存在异常` |
| RobertoSantos6003（从未领过，今日无投放） | HTTP 405 `code=3012` 同上 |

**结论**：
1. **投放空 = 无法领取**，在 claim 端点 HTTP 层实锤——服务端以 3012 风控话术回绝，
   实际是投放资格闸，不区分"从未领过"与"领过但已到期"；
2. 3012 在 claim 语境**不是账号级标记**：同 IP 同时段，已领号正常过闸到业务层（1003），
   说明闸判的是账号当前投放/套餐状态而非请求形状或出口 IP；
3. 闸序：**3007 验证码闸 → 3012 投放资格闸 → 业务层（1003 已领 / 1005 期内重复 / 0 成功）**；
4. 与 §8/§9 闭环：资格既不会被失败撤销（客户端零操作），也不能绕过空投放直接领
   （服务端闸死）——投放配额（≈5/环境/日）是唯一获取路径。

工具：`tools/captcha_probe.html`（无痕产真票；必须带 prefix/region，否则产降级票必 3007）。
