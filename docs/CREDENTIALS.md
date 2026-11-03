# 凭证格式：本机真实凭证与 OAuth 添加产物

两条入库链，最终都以同一种「账号快照」形态存在 `~/.zcode-switch/accounts/` 下：

1. **本机真实凭证**：ZCode 客户端自己写到 `~/.zcode/v2/credentials.json` 的活凭证，「保存登录」（`capture_current` → `store::capture_current`，store.rs）原样抄进来；
2. **OAuth 添加**：添加弹窗走 `oauth_begin`（lib.rs）→ 授权码/轮询换 token → `oauth::assemble_credentials_with_token`（oauth.rs:438）在内存里组装出一份同构的 credentials 对象直接入库，不经过本机文件。

---

## 1. 本机真实凭证 `~/.zcode/v2/credentials.json`

一个 JSON 对象（store.rs `read_live`，路径定义 `Paths::live_file`，store.rs:106）。实测/实现中出现的键：

| 键 | 形态 | 说明 |
|---|---|---|
| `zcodejwttoken` | 字符串，可能 `enc:v1:` 密文 | ZCode 会话 JWT，claim/quota/messages 链的 Bearer 来源；`jwt_exp_ms` 解 payload 取 `exp`（30s 时钟容差，store.rs:662） |
| `oauth:active_provider` | 字符串 | 当前 OAuth 供应商：`bigmodel` / `zai` |
| `oauth:{provider}:access_token` | 字符串，可能加密 | 供应商 access token |
| `oauth:{provider}:refresh_token` | 字符串，可能加密 | 仅 bigmodel 有（oauth.rs `extract_refresh_token`） |
| `oauth:{provider}:user_info` | 字符串（JSON 序列化后的串） | userinfo 载荷 |
| `web-remote-control:*` | 任意 | 设备侧键，**不参与账号同一性判定**（见下） |

判断「已登录」（`is_logged_in`，store.rs:245）：存在任意 `oauth:*:access_token` 键，**或** `zcodejwttoken` 非空。

### 加密：`enc:v1`（zcrypto.rs）

值以 `enc:v1:` 前缀开头的即密文，格式与 ZCode 官方客户端的加密一致，zcode-hub 可双向互解：

```
enc:v1:<b64url(nonce)>.<b64url(tag)>.<b64url(ciphertext)>
```

- 算法 AES-256-GCM，nonce 12 字节，tag 与密文分存两段（解密时 tag 拼回密文尾部）；
- 密钥 = `SHA256(secret)`，secret 来自（`default_secret`，zcrypto.rs:46）：
  - 环境变量 `ZCODE_CREDENTIAL_SECRET` 优先；
  - 否则回退串 `zcode-credential-fallback:{platform}:{home}:{username}`，其中 `platform` ∈ `win32`/`darwin`/`linux`（Node 风格命名，`node_platform_for`），`home` 为用户主目录路径原文，`username` 取 `USERNAME`（Windows）或 `id -un`/`USER`（Unix）。

因此明文等价可恢复，外部工具（脚本/2api）按同一公式可解出 `zcodejwttoken` 直接打 messages。

### 账号同一性：canonical hash（`canonical_hash`，store.rs:228）

把对象里所有 `web-remote-control:*` 键剔除后做规范化 JSON 序列化，SHA-256 取十六进制。快照的 `hash` 字段即此值，切换/判重/`get_state` 的 `active_account_id` 全靠它对齐。

## 2. OAuth 添加流程的凭证产物

`oauth_begin` 换到 token 后，`assemble_credentials_with_token`（oauth.rs:438）组装出与本机格式同构的对象：

```jsonc
{
  "zcodejwttoken": "<exchange_token 换取的 JWT>",
  "oauth:active_provider": "bigmodel | zai",
  "oauth:bigmodel:access_token": "…",       // 有则写入；zai 同理 oauth:zai:access_token
  "oauth:bigmodel:refresh_token": "…",      // 仅 bigmodel
  "oauth:bigmodel:user_info": "{\"…\"}"     // userinfo 原样 JSON 字符串化
}
```

要点：

- **key 名与本机格式完全一致**，入库后与「保存登录」的快照在 `switch_to`/`quota`/`claim` 各链上无差别对待；
- 大模型侧 access token 会再经 `resolve_biz_api_key` / `resolve_zai_business_token`（oauth.rs:547/594）换算出业务 API Key，写入 config 而非 credentials。

同时 `assemble_config`（oauth.rs:618）生成 ZCode 的 provider 配置（新代数落 `provider_config.json`，旧代数落 `v2/config.json`，`snapshot_config_from_live` 按代数取舍），每条目形态：

```jsonc
{
  "provider": {
    "builtin:bigmodel":             { "name": "Bigmodel - API Key",  "kind": "anthropic", "options": { "apiKey": "<业务key>", "baseURL": "https://open.bigmodel.cn/api/anthropic" }, "enabled": true, "source": "custom" },
    "builtin:bigmodel-coding-plan": { "…同上…" },
    "builtin:bigmodel-start-plan":  { "options": { "apiKey": "<JWT>", "baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic" } },
    "builtin:zai":                  { "name": "Z.ai - API Key",   "options": { "apiKey": "" } },
    "builtin:zai-coding-plan":      { "options": { "apiKey": "<业务key>", "baseURL": "https://api.z.ai/api/anthropic" } },
    "builtin:zai-start-plan":       { "options": { "apiKey": "<JWT>", "baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic" } }
  }
}
```

规则：`kind` 恒为 `anthropic`、`source: "custom"`；`enabled` 仅当 apiKey 非空（空时带 `apiKeyRequired: true`）；start-plan 档直接把 JWT 当 apiKey 打 `START_PLAN_ANTHROPIC_BASE`。

## 3. 入库后的账号快照

两种来源统一落 `~/.zcode-switch/accounts/<id>.json`（`Account`，store.rs:119）：

```jsonc
{
  "id": "…", "name": "…", "created_at": "…", "updated_at": "…",
  "hash": "<canonical_hash>",
  "credentials": { …上文第 1/2 节的完整对象… },
  "config": { …上文第 2 节 provider 配置，保存登录的旧代数快照才有；OAuth 流程与新代数下为 null… },
  "virtual_device_mid": "…",   // 虚拟设备 mid（claim/quota 身份块用）
  "virtual_arms_uid": "…"
}
```

## 相关代码

- `src-tauri/src/zcrypto.rs` — enc:v1 加解密、secret 推导、JWT exp、账号身份
- `src-tauri/src/store.rs` — read_live / is_logged_in / canonical_hash / capture_current / Account
- `src-tauri/src/oauth.rs` — exchange_token / assemble_credentials_with_token / assemble_config
- `src-tauri/src/lib.rs:227-233, 573-587` — capture_current 与 oauth_begin IPC 入口
