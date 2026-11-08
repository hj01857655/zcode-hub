# billing/balance 接口文档

> 数据来源：`src-tauri/src/quota.rs`（URL/头/归一化）+ 2026-11-07 实测响应（账号 ShannonYoung8131，200，157ms）。
> 凭据格式与解密见 [CREDENTIALS.md](CREDENTIALS.md)。

## 1. 端点

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version={ver}
```

- `app_version`：客户端自述版本，额度通道走探测值（`zcode_app_version()`，本机 3.17.1），见 [APP-VERSION.md](APP-VERSION.md)。
- 调用点：`quota.rs:498`（主查询）、`quota.rs:710` 附近（claim 后置确认轮询）；归一化 `normalize_balance`。
- 客户端重试策略：仅 429 退避重试（500/1500/4000ms 三轮，`http_get_json` `quota.rs:410`）；401/403 直接失败不重试。

## 2. 认证与请求头

**Bearer 来源是 `zcodejwttoken`，不是 `oauth:zai:access_token`**——实测 oauth access token 打此端点回 401（空 body），换 `zcodejwttoken` 即 200。与 CREDENTIALS.md 口径一致：quota/claim/messages 链的 Bearer 都取 `zcodejwttoken`。

头集合 = `zai_billing_headers_with_mid`（`quota.rs:202` → `zai_headers_with_version` `quota.rs:226`）：

| 头 | 值（实测） |
|---|---|
| `Authorization` | `Bearer <zcodejwttoken>` |
| `User-Agent` | `ZCode/3.17.1` |
| `HTTP-Referer` | `https://zcode.z.ai` |
| `X-Title` | `Z Code@electron` |
| `X-ZCode-App-Version` | `3.17.1` |
| `X-Platform` | `windows` |
| `X-Release-Channel` | `stable` |
| `X-Client-Language` | `zh-CN` |
| `X-Client-Timezone` | `Asia/Shanghai` |
| `X-Os-Category` | `windows` |
| `X-Os-Version` | `10.0.26300`（注册表 CurrentBuildNumber） |
| `X-Device-Mid` | `~/.zcode/v2/telemetry-state.json` 的 `deviceMid` |
| `x-request-id` | 每次随机 UUID |

`X-Device-Mid` 未带也能过（老号无 mid 照样出数据），但带上是正确姿态；token 为 `enc:v1:` 密文时按 CREDENTIALS.md 公式解出。

## 3. 原始响应（2026-11-07 实测原文，逐字节未改）

HTTP 200，157ms，账号 ShannonYoung8131，token 取 `zcodejwttoken`（`enc:v1:` 解密），全量头含 `X-Device-Mid`。探针外层元数据（account/status/elapsed_ms/device_mid_used）与上游响应一并原样存档：

```json
{
  "account": "ShannonYoung8131",
  "status": 200,
  "elapsed_ms": 157,
  "device_mid_used": true,
  "response": {
    "code": 0,
    "msg": "",
    "data": {
      "server_time": 1794010672,
      "plans": [
        {
          "user_plan_id": "upl_2118665624914460672",
          "plan_id": "zcode-v3-start-plan-1106-wk",
          "name": "ZCODE WEEKEND BUILD",
          "description": "",
          "priority": 101,
          "status": "active",
          "starts_at": 1793964222,
          "ends_at": 1794186000,
          "entitlements": [
            {
              "entitlement_id": "ent-zcode-v3-start-plan-1106-wk-1",
              "show_name": "GLM-5.3-Flash",
              "meter": "model_usage",
              "unit_type": "token",
              "capabilities": [
                "model:glm-5.3-flash"
              ],
              "grant_units": 500000000,
              "period": "one_time",
              "priority": 101,
              "effective_at": 1793977200
            }
          ]
        }
      ],
      "balances": [
        {
          "bucket_id": "bucket_2118721319940620288",
          "user_plan_id": "upl_2118665624914460672",
          "plan_id": "zcode-v3-start-plan-1106-wk",
          "entitlement_id": "ent-zcode-v3-start-plan-1106-wk-1",
          "show_name": "GLM-5.3-Flash",
          "meter": "model_usage",
          "unit_type": "token",
          "capabilities": [
            "model:glm-5.3-flash"
          ],
          "priority": 101,
          "plan_priority": 101,
          "entitlement_priority": 101,
          "total_units": 500000000,
          "used_units": 0,
          "remaining_units": 500000000,
          "available_units": 500000000,
          "period_start": 1793964222,
          "period_end": 1794186000,
          "expires_at": 1794186000
        }
      ]
    },
    "logid": "20261107001752219323241822a9231cb0"
  }
}
```

字段说明（供检索，原文以上为准）：


| 字段 | 实测值 | 说明 |
|---|---|---|
| `user_plan_id` | `upl_2118665624914460672` | 用户套餐实例 ID，balances 关联键 |
| `plan_id` | `zcode-v3-start-plan-1106-wk` | 套餐模板 ID（末缀 `wk`=周包） |
| `name` | `ZCODE WEEKEND BUILD` | 显示名 |
| `priority` | `101` | 套餐优先级（扣减顺序） |
| `status` | `active` | 生命周期状态 |
| `starts_at` / `ends_at` | `1793964222` / `1794186000` | Unix 秒，有效期 |
| `entitlements[]` | 见下 | 权益（一个套餐可含多项） |

### plans[].entitlements[] 权益项

| 字段 | 实测值 |
|---|---|
| `entitlement_id` | `ent-zcode-v3-start-plan-1106-wk-1` |
| `show_name` | `GLM-5.3-Flash` |
| `meter` | `model_usage` |
| `unit_type` | `token` |
| `capabilities` | `["model:glm-5.3-flash"]` |
| `grant_units` | `500000000`（5 亿 token，原始单位） |
| `period` | `one_time`（非滚动周期，用完即止） |
| `priority` / `effective_at` | `101` / `1793977200` |

### balances[] 余额项

| 字段 | 实测值 | 说明 |
|---|---|---|
| `bucket_id` | `bucket_2118721319940620288` | 扣减桶 ID |
| `user_plan_id` / `plan_id` / `entitlement_id` | 同上三键 | 关联套餐与权益 |
| `meter` / `unit_type` / `capabilities` | 同权益 | |
| `priority` / `plan_priority` / `entitlement_priority` | `101` ×3 | 三层优先级 |
| `total_units` | `500000000` | 总量 |
| `used_units` | `0` | 已用 |
| `remaining_units` / `available_units` | `500000000` | 剩余 / 当前可用 |
| `period_start` / `period_end` / `expires_at` | 同套餐时间 | |

归一化注意（`normalize_balance`）：UI 展示的额度是 `remaining_units` 按模型换算后的值；`/v1/models` 模型面按 `capabilities` 聚合（gateway `pool.rs`）。

## 4. 判定与错误码

- 成功判定 `business_ok`（`quota.rs:520`）：`code` 缺省/200/0 且 `success != false`。
- HTTP 层（`http_get_json`）：
  - body `code==401` → token 业务失效（`err.token.biz401`）；
  - HTTP 429 → 退避重试三轮后报 `err.quota.rate_limited`；
  - HTTP 401/403 → `err.token.http401`（token 过期/被吊销，需重新 OAuth）；
  - 其余 HTTP 错误取 body 的 `message/msg/error` 展示。
- 实测 401 形态：**空 body + HTTP 401**——用错 token 类型（oauth access token）即如此，与「token 真过期」无法从响应区分，需对照 `zcodejwttoken`。
- 配套额度端点（同文件，均实测在用）：
  - `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（bigmodel 通道，`quota.rs:20`）
  - `GET https://open.bigmodel.cn/api/biz/subscription/list`（订阅列表，`quota.rs:21`）
- **订阅先行闸门（2026-11-08）**：bigmodel 通道两处——`query_with_token_via` 兑底腿与 `query_channels_via` 的 Monitor 臂——均改为 `subscription/list` 先探：`data[]` 含在期 coding 套餐（`is_active_coding_plan_entry`）才打 `quota/limit` 用量；订阅空 → 直接定论「无套餐」（`no_plan_overview`）；订阅业务 401/1006（Auth 族）→ 直接报 `err.token.biz401`。仅订阅网络失败或非鉴权业务失败时保留 monitor 直打兑底（旧行为）。与切换探针 `probe.rs classify_via` 的 Monitor 通道判定语义一致——monitor 端点不再对无效凭据每轮白打（401「令牌已过期」刷屏治理）。

## 5. 可复现探针

探针脚本：`balance_probe.py`（会话工作区），用法：

```bash
python -I balance_probe.py "C:\Users\12925\.zcode-hub\accounts\<account>.json" out.json
```

自动取 `zcodejwttoken`（`enc:v1:` 按公式解密）、带全量头打 balance，输出含 HTTP 状态与耗时。原始响应存档：会话工作区 `balance_resp.json`（2026-11-07 实测）。
