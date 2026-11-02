# ZCode 客户端版本头策略

一句话：**额度/OAuth/touch/preview 通道统一走探测版本**（注册表读本机实际安装的 ZCode 版本，当前 3.17.1）；**动作端点钉 3.16.3**（`quota::SAFE_APP_VERSION`）——gateway messages（2026-11-01 定案，详见 [GATEWAY.md §6.5](GATEWAY.md)）与 billing/claim（2026-11-02 口径）两处，WAF 对「3.17.1 自报」的动作类请求判 3012/405。

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
| 领取 preview（头 + URL 参数） | `claim.rs` `preview_plans`/`preview_once`（`zai_billing_headers_with_mid`，探测值） |
| 领取 claim（动作端点） | `claim.rs` `submit_claim`（`zai_claim_headers_with_mid`）——**钉 3.16.3** |
| 营销投放 marketing/touch（头 + URL） | `claim.rs:266/271`——此端点对 `app_version` 敏感，老版本头返回空 deliveries，探测值天然满足 |
| 账号切换写回 | `store.rs:910` |
| gateway messages（模型对话） | `gateway/upstream.rs headers()`——**例外**：钉 3.16.3，不走探测值 |

## 历史

- 2026-10-30（P0）：修复 `CLIENT_APP_VERSION` 硬编码过时（注册表实测本机 3.16.3）；OAuth 与 billing 版本源归一。
- 2026-10-31：preview 下发与版本头无关（3.14.0/3.16.3/3.17.1 响应逐字节相同）；`billing/claim` 以 3.17.1 头连续 12 个账号全部 200，3.14.0 头一律回 1004——claim/touch 通道要求 3.17.1 真实版本头。删除 `CLAIM_APP_VERSION` 与 `zai_claim_headers_with_mid`，版本源归一至探测值。
- 2026-11-01：messages 端点版本闸定案——`User-Agent` / `X-ZCode-App-Version` 自报 3.17.1 回 3012/405，自报 3.14.0/3.16.3 均 200；gateway `upstream.rs` 据此以 `SAFE_APP_VERSION` 钉 3.16.3。
- 2026-11-02：claim 动作端点口径回归钉档——`SAFE_APP_VERSION` 上移 `quota.rs` 成单一来源，新增 `zai_claim_headers_with_mid`（10-31 删的同名机制回归），`submit_claim` 是唯一调用点；`gateway/upstream.rs` 本地常量改引用。实测（三套 TLS 栈一致：ureq/rustls、CPython urllib×3.17.1 与 ×3.16.3 头）：投放内账号 claim 均可达业务层（1003 重复领取 200），非投放账号两档头一律 405/3012——**3012 为账号级反枚举判定，与版本头无归因**；钉 3.16.3 按用户口径执行，与 messages 同代际。

## 维护守则

- **ZCode 升级**：只改 `CLIENT_APP_VERSION` 兜底值，探测自动跟随实际安装
- **不要再给任何通道加专用版本常量**：除非有「该通道版本头换成 X → 明确报错 Y」的对照实验记录（messages 即凭此钉 3.16.3），或操作人明示口径（claim 属后者：实测 3.17.1 头领取可通过，钉 3.16.3 是按「动作端点一律降档」的预防性口径执行，与 messages 同代际）
- 探测结果 `OnceLock` 缓存于进程生命周期，ZCode 升级后本工具需重启才会用新版本号（已知限制，P2）
