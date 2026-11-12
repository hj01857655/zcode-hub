# farm_probe.py — gateway 农场链路真实出话探针（GATEWAY.md §6.5 遗留项验证）
# 同构复刻 src-tauri/src/gateway 新链路：farm_members 选号 → 版本头族 + per-account mid
# → translate（前缀 cache_control + metadata.user_id）→ messages 上游 → SSE 聚合。
# 用法：python scripts/farm_probe.py [--model GLM-5.3-Flash] [--ask "1+1 等于几？只回数字"]
import base64
import json
import os
import platform
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
import winreg
from hashlib import sha256
from pathlib import Path

HOME = Path.home()
# 数据目录已迁移 .zcode-switch → .zcode-hub（store.rs 6f99161 同步）；旧名回落兼容
SWITCH_DIR = HOME / ".zcode-hub" if (HOME / ".zcode-hub" / "accounts").is_dir() else HOME / ".zcode-switch"
UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
CLIENT_APP_VERSION_FALLBACK = "3.17.1"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def b64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def derive_key():
    plat = {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}[platform.system()]
    user = os.environ.get("USERNAME") or ""
    return sha256(f"zcode-credential-fallback:{plat}:{HOME}:{user}".encode()).digest()


KEY = derive_key()


def dec(v):
    if not (isinstance(v, str) and v.startswith("enc:v1:")):
        return v
    iv, tag, ct = (b64u(x) for x in v[len("enc:v1:"):].split("."))
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(KEY).decrypt(iv, ct + tag, None).decode("utf-8", "replace")


def jwt_exp(jwt):
    try:
        payload = json.loads(b64u(jwt.split(".")[1]))
        return int(payload.get("exp", 0))
    except Exception:
        return 0


def zcode_app_version():
    # quota.rs zcode_app_version 同构：注册表 Uninstall 枚举，DisplayName 含 zcode 且不含 switch
    for hive in [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]:
        try:
            k = winreg.OpenKey(hive[0], hive[1])
        except OSError:
            continue
        with k:
            for i in range(winreg.QueryInfoKey(k)[0]):
                try:
                    sub = winreg.OpenKey(k, winreg.EnumKey(k, i))
                except OSError:
                    continue
                with sub:
                    try:
                        name, _ = winreg.QueryValueEx(sub, "DisplayName")
                        ver, _ = winreg.QueryValueEx(sub, "DisplayVersion")
                    except OSError:
                        continue
                    l = str(name).lower()
                    if "zcode" in l and "switch" not in l:
                        parts = str(ver).split(".")
                        return ".".join(parts[:3]) if len(parts) >= 3 else str(ver)
    return CLIENT_APP_VERSION_FALLBACK


def os_version():
    try:
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        with k:
            build, _ = winreg.QueryValueEx(k, "CurrentBuildNumber")
        return f"10.0.{build}"
    except OSError:
        return None


def farm_members():
    # pool.rs farm_members 同构：跳过未登录 / jwt 过期 / token 解密失败，单号不连坐
    out = []
    for f in sorted(SWITCH_DIR.glob("accounts/*.json")):
        if ".bak" in f.name:
            continue
        try:
            acc = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        jwt = dec(acc.get("credentials", {}).get("zcodejwttoken", "") or "")
        if not jwt or len(jwt) < 20:
            continue
        exp = jwt_exp(jwt)
        if exp and exp < time.time():
            print(f"  [skip] {acc.get('name', f.stem)}: jwt expired")
            continue
        out.append({"id": acc["id"], "name": acc.get("name", acc["id"]), "token": jwt,
                    "mid": acc.get("virtual_device_mid")})
    return out


def headers_for(token, mid, ver, thin=False):
    # thin=True：仅鉴权+类型两条（M3-E 实测 200 形态，gateway 默认）；否则全头族（quota.rs 同构，3012 嫌疑形态）
    if thin:
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    # quota.rs zai_headers_with_version 同构 + messages 专用头（upstream.rs headers）
    h = {
        "User-Agent": f"ZCode/{ver}",
        "HTTP-Referer": "https://zcode.z.ai",
        "X-Title": "Z Code@electron",
        "X-ZCode-App-Version": ver,
        "X-Platform": "win32-x64",
        "X-Release-Channel": "stable",
        "X-Client-Language": "zh-CN",
        "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": "windows",
        "Authorization": f"Bearer {token}",
        "x-request-id": str(uuid.uuid4()),
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    if mid:
        h["X-Device-Mid"] = mid
    if (v := os_version()):
        h["X-Os-Version"] = v
    return h


def build_body(prefix, ask, model):
    # translate.rs anthropic_to_upstream 同构：前缀块 + 用户段均带 cache_control ephemeral
    system = [{"type": "text", "text": t, "cache_control": {"type": "ephemeral"}} for t in prefix]
    uid = json.dumps({"device_id": str(uuid.uuid4()), "account_uuid": "", "session_id": ""})
    return {
        "model": model,
        "messages": [{"role": "user", "content": ask}],
        "max_tokens": 512,
        "stream": True,
        "system": system,
        "metadata": {"user_id": uid},
    }


def aggregate(raw):
    # translate.rs aggregate_sse 同构（text/thinking/usage/cache 命中）
    text, thinking, usage = "", "", {}
    for line in raw.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            ev = json.loads(line[6:])
        except Exception:
            continue
        t = ev.get("type")
        if t == "content_block_delta":
            d = ev.get("delta", {})
            if d.get("type") == "text_delta":
                text += d.get("text", "")
            elif d.get("type") == "thinking_delta":
                thinking += d.get("thinking", "")
        elif t == "message_start":
            usage.update(ev.get("message", {}).get("usage", {}))
        elif t == "message_delta":
            usage.update(ev.get("usage", {}))
        elif t == "error":
            return text, thinking, usage, ev
    return text, thinking, usage, None


def main():
    model = "GLM-5.3-Flash"
    ask = "1+1 等于几？只回数字"
    thin = "--thin" in sys.argv
    args = sys.argv[1:]
    if "--model" in args:
        model = args[args.index("--model") + 1]
    if "--ask" in args:
        ask = args[args.index("--ask") + 1]

    ver = zcode_app_version()
    if "--ver" in args:
        ver = args[args.index("--ver") + 1]  # 归因实验覆盖（对齐 ZCODE_GATEWAY_APP_VERSION 口径）
    print(f"app_version = {ver}")
    prefix = json.loads(
        (Path(__file__).resolve().parent.parent / "src-tauri/src/gateway/assets/prefix.json")
        .read_text(encoding="utf-8")
    )["system_prefix"]
    print(f"前缀段数 = {len(prefix)}，总字符 = {sum(len(s) for s in prefix)}")

    members = farm_members()
    print(f"farm 成员 = {len(members)}: {[m['name'] for m in members]}")
    if not members:
        print("farm 为空，退出")
        return 1

    body = build_body(prefix, ask, model)
    payload = json.dumps(body).encode()

    # pick + 换号重放一轮（pool.rs 调度的单发缩影）
    for m in members:
        h = headers_for(m["token"], m["mid"], ver, thin)
        print(f"\n=== 尝试 {m['name']} (mid={ (m['mid'] or '')[:8] }…) 头集={'thin' if thin else 'full'} ===")
        try:
            req = urllib.request.Request(UPSTREAM, method="POST", data=payload, headers=h)
            with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
                raw = r.read().decode("utf-8", "replace")
                print(f"HTTP {r.status}")
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", "replace")[:600]
            print(f"HTTP {e.code}: {err_body}")
            if "3012" in err_body or e.code == 405:
                print("全局风控档（3012/405），停止——当日不再重试")
                return 1
            continue  # 换号重放
        text, thinking, usage, err = aggregate(raw)
        if err:
            print(f"SSE error 事件: {err}")
            continue
        print(f"回复: {text!r}")
        if thinking:
            print(f"thinking: {thinking[:120]!r}…")
        cr = usage.get("cache_read_input_tokens")
        print(f"usage: in={usage.get('input_tokens')} out={usage.get('output_tokens')} "
              f"cache_read={cr} cache_create={usage.get('cache_creation_input_tokens')}")
        return 0
    print("全部成员失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
