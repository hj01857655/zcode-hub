# ZCode 客户端版本头策略

一句话：**除 gateway messages 外全部通道走探测版本**（注册表读本机实际安装的 ZCode 版本，当前 3.17.2）——额度/OAuth/touch 读取与 **领取 claim / 投放动作上报**（均 2026-11-03 订正）；**只有模型对话钉 3.16.3**（`quota::SAFE_APP_VERSION`，见 [GATEWAY.md §6.5](GATEWAY.md)）——WAF 对「3.17.x 自报」的 messages 请求判 3012/405，那是对话风控闸，与领取资格闸不同源。

## 版本源

| 来源 | 值 | 位置 | 说明 |
|---|---|---|---|
| `zcode_app_version()` | 探测值（如 `3.17.1`） | `src-tauri/src/quota.rs:136` | 遍历注册表卸载表项取 ZCode 的 DisplayVersion，`OnceLock` 进程级缓存；探测失败回落 `CLIENT_APP_VERSION` |
| `CLIENT_APP_VERSION` | `"3.17.1"` | `src-tauri/src/quota.rs:23` | 仅作探测兜底，与探测目标同步维护 |

请求头里 `User-Agent: ZCode/<ver>` 与 `X-ZCode-App-Version: <ver>` 同源，由 `zai_headers_with_version` 统一拼装（`quota.rs:203`）。

## 通道矩阵（按通道取版本源）

| 通道 | 生效位置 |
|---|---|
| 模型请求 UA（bigmodel） | `quota.rs:226` |
| 额度 billing/balance（头 + URL 参数） | `quota.rs:193`（头）、`quota.rs:475/710`（URL） |
| 探测通道 probe | `probe.rs:194`（URL）、`probe.rs:238`（头） |
| OAuth（头 + redirect_uri 参数） | `quota.rs:199`、`oauth.rs:25` |
| 领取可领清单（头 + URL 参数） | `claim.rs` `touch_plans`（`zai_billing_headers_with_mid`，探测值）——`billing/preview` 通道已整体删除 |
| 领取 claim（动作端点） | `claim.rs` `submit_claim`（`zai_claim_headers_with_mid`）——**跟投放同档（探测值）**，钉低档得 1004（见历史 2026-11-03 第二条订正） |
| 投放动作上报 marketing/touch/action | `claim.rs` `touch_report`（`zai_claim_headers_with_mid`）——同上，探测值 |
| 营销投放 marketing/touch（头 + URL） | `claim.rs` `touch_plans`（`zai_billing_headers_with_mid`，探测值）——**此端点按 `app_version` 过滤投放**，钉低档会把在线投放整体滤空（见历史 2026-11-03 订正条） |
| 账号切换写回 | `store.rs:910` |
| gateway messages（模型对话） | `gateway/upstream.rs headers()`——**唯一钉档通道**：钉 3.16.3，撞风控自动降 3.14.0，不走探测值 |

## 历史

- 2026-10-30（P0）：修复 `CLIENT_APP_VERSION` 硬编码过时（注册表实测本机 3.16.3）；OAuth 与 billing 版本源归一。
- 2026-10-31：preview 下发与版本头无关（3.14.0/3.16.3/3.17.1 响应逐字节相同）；`billing/claim` 以 3.17.1 头连续 12 个账号全部 200，3.14.0 头一律回 1004——claim/touch 通道要求 3.17.1 真实版本头。删除 `CLAIM_APP_VERSION` 与 `zai_claim_headers_with_mid`，版本源归一至探测值。
- 2026-11-01：messages 端点版本闸定案——`User-Agent` / `X-ZCode-App-Version` 自报 3.17.1 回 3012/405，自报 3.14.0/3.16.3 均 200；gateway `upstream.rs` 据此以 `SAFE_APP_VERSION` 钉 3.16.3。
- 2026-11-02：claim 动作端点口径回归钉档——`SAFE_APP_VERSION` 上移 `quota.rs` 成单一来源，新增 `zai_claim_headers_with_mid`（10-31 删的同名机制回归），`submit_claim` 是唯一调用点；`gateway/upstream.rs` 本地常量改引用。实测（三套 TLS 栈一致：ureq/rustls、CPython urllib×3.17.1 与 ×3.16.3 头）：投放内账号 claim 均可达业务层（1003 重复领取 200），非投放账号两档头一律 405/3012——**3012 为账号级反枚举判定，与版本头无归因**；钉 3.16.3 按用户口径执行，与 messages 同代际。
- 2026-11-03：客户端 3.17.2 发布（2026-11-02 日志），`CLIENT_APP_VERSION` 兜底同步 3.17.2；探测值以注册表实际安装版本为准（未升级机器仍回旧探测值）。3.17.2 与版本闸相关的行为变化未知——升级后需复测 messages 钉档（3.16.3 是否仍 200）与 billing/touch 真实版本头。
- 2026-11-03（订正）：当日一度把 `zcode_app_version()` 改为恒返 `SAFE_APP_VERSION`（理由「读取通道版本不敏感」）。该结论已被推翻：同账号同 mid 只换 `app_version`，`3.17.2` 下投放可见、`3.16.3`/`3.14.0` 下 `deliveries: 0`；全池 14 号用探测值有 9 号看到 `zcode-v3-start-plan-1103`（campaign 2101141259813175296），用钉档值 0 号可见——UI 因此报「资格已刷新 · 暂无可领套餐」。原对照实验是在投放尚未上线的时间窗做的，两边都空，被当成「不敏感」。`zcode_app_version()` 已恢复走注册表探测（`registry_probe_app_version`），写端点继续钉档；对照脚本 `scripts/touch_live.py --ver`。

- 2026-11-03（订正二：领取通道）：读取通道恢复探测值后，探测能拿到投放但 claim 回 `1004 不符合领取条件 (no permission)`。根因同源：投放按 `app_version` 下发，领取自述必须与看到投放的**同一档**，低一档服务端视为「该档客户端无此投放」→ 1004。`zai_claim_headers_with_mid`（`submit_claim` + `touch_report`）改随 `zcode_app_version()`，`SAFE_APP_VERSION` 仅留 gateway messages。旧记录早就写着这一半答案（10-31：3.17.1 头连续 12 号全部 200，3.14.0 头一律 1004），11-02「动作端点一律降档」把它当成预防性口径覆盖掉了，本次按实测回归。

## 维护守则

- **ZCode 升级**：只改 `CLIENT_APP_VERSION` 兜底值，探测自动跟随实际安装
- **不要再给任何通道加专用版本常量**：除非有「该通道版本头换成 X → 明确报错 Y」的对照实验记录。**投放与领取必须同档**（两边版本头不一致 → 要么看不到投放，要么 1004）；messages 凭「3.17.x 自报 → 3012/405」单独钉档，属另一类闸，不可类推到领取链
- 探测结果 `OnceLock` 缓存于进程生命周期，ZCode 升级后本工具需重启才会用新版本号（已知限制，P2）
