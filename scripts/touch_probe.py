#!/usr/bin/env python3
# 逐号打 marketing/touch（投放权威信号）+ billing/preview，定位"不可领取"的真实原因。
# 复用 farm_probe.py 的凭据解密与请求头同构实现。
import base64, hashlib, json, os, platform, ssl, sys, urllib.request, urllib.error, uuid
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HOME = Path.home()
SWITCH_DIR = HOME / ".zcode-switch"
TOUCH = "https://zcode.z.ai/api/v1/marketing/touch?seq=1&app_version={v}&platform={p}"
PREVIEW = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version={v}&platform={p}"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from farm_probe import dec, zcode_app_version, os_version  # 复用解密/版本探测

ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
VER = zcode_app_version()
print(f"app_version = {VER}\n")

def headers(token, mid):
    h = {
        "User-Agent": f"ZCode/{VER}", "HTTP-Referer": "https://zcode.z.ai",
        "X-Title": "Z Code@electron", "X-ZCode-App-Version": VER, "X-Platform": "win32-x64",
        "X-Release-Channel": "stable", "X-Client-Language": "zh-CN", "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": "windows", "Authorization": f"Bearer {token}",
        "x-request-id": str(uuid.uuid4()), "Content-Type": "application/json",
        # messages 端点需要（与网关 proxy 层同款）；billing/touch 端点忽略之
        "anthropic-version": "2023-06-01",
    }
    if mid: h["X-Device-Mid"] = mid
    if (ov := os_version()): h["X-Os-Version"] = ov
    return h

def get(url, token, mid):
    req = urllib.request.Request(url.format(v=VER, p="win32-x64"), headers=headers(token, mid))
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            return json.loads(r.read().decode("utf-8", "replace")), 200
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read().decode("utf-8","replace")), e.code
        except Exception: return {"_raw": e.read()[:200].decode("utf-8","replace")}, e.code
    except Exception as e:
        return {"_err": str(e)}, -1

def account_list():
    secret_home = HOME  # dec 用全局 KEY（farm_probe 内 derive_key 与 Rust default_secret 同构）
    for f in sorted(SWITCH_DIR.glob("accounts/*.json")):
        acc = json.loads(f.read_text(encoding="utf-8"))
        creds = acc.get("credentials", {})
        tok = dec(creds.get("zcodejwttoken", "") or "")
        yield acc.get("name", f.stem), acc.get("id", ""), tok, acc.get("virtual_device_mid")

def touch_claim_ids(v):
    dels = (v.get("data") or {}).get("deliveries") or []
    ids = []
    for d in dels:
        for b in (d.get("banner", {}) or {}).get("buttons", []) or []:
            act = b.get("action") or {}
            if act.get("type") == "claim_zcode_plan":
                pid = (act.get("args") or {}).get("plan_id") or (act.get("args") or {}).get("planId")
                if pid: ids.append(pid)
    return ids

# 对话探测（messages）：model/版本可调。version=None 用探测版本（真实头）；
# 传 "3.16.3" 钉 claim/messages 实锤安全档。返回 (http_code, 解析后的 dict 或 None)。
def probe_messages(token, mid, model="GLM-5.3-Flash", version=None, max_tokens=16, prompt="回复两个字：收到"):
    ver = version or VER
    h = headers(token, mid)
    h["User-Agent"] = f"ZCode/{ver} ai-sdk/anthropic/3.0.81"
    h["X-ZCode-App-Version"] = ver
    body = json.dumps({"model": model, "max_tokens": max_tokens, "stream": False,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(
        "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
        data=body, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, None

print(f"{'账号':<18} {'touch投放(claim)':<10} {'preview计划数':<12} 明细")
print("-" * 78)
for name, aid, tok, mid in account_list():
    tv, tc = get(TOUCH, tok, mid)
    pv, pc = get(PREVIEW, tok, mid)
    ids = touch_claim_ids(tv) if tc == 200 else []
    plans = ((pv.get("data") or {}).get("plans") or pv.get("data") or []) if pc == 200 else []
    n_plans = len(plans) if isinstance(plans, list) else 0
    note = ""
    if tc != 200: note = f"TOUCH {tc} {str(tv.get('_err') or tv.get('msg') or tv)[:40]}"
    elif not ids: note = "touch 无 claim 投放 → 不可领"
    print(f"{name:<18} {'有:'+','.join(ids) if ids else '无':<10} {n_plans:<12} {note}")
