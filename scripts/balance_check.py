#!/usr/bin/env python3
# balance_check.py — 逐号打 billing/balance，核验每个账号当前真实持有的套餐与余额。
# 目的：核清「探测到投放资格」与「领取成功」的差距。JWT 为明文时直接用，enc:v1: 密文走 farm_probe.dec。
# 用法：python scripts/balance_check.py
import json
import ssl
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from farm_probe import dec, os_version  # 复用解密 / OS 版本探测

HOME = Path.home()
ACCT_DIR = HOME / ".zcode-hub" / "accounts"  # 当前 app 实际入库目录（非 docs 里的 .zcode-switch）
BALANCE = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance"
VER = "3.17.1"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

CST = timezone(timedelta(hours=8))


def headers(token, mid, ver):
    h = {
        "User-Agent": f"ZCode/{ver}",
        "HTTP-Referer": "https://zcode.z.ai",
        "X-Title": "Z Code@electron",
        "X-ZCode-App-Version": ver,
        "X-Platform": "windows",
        "X-Release-Channel": "stable",
        "X-Client-Language": "zh-CN",
        "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": "windows",
        "Authorization": f"Bearer {token}",
        "x-request-id": str(uuid.uuid4()),
    }
    if mid:
        h["X-Device-Mid"] = mid
    if (ov := os_version()):
        h["X-Os-Version"] = ov
    return h


def fetch_balance(token, mid, ver):
    url = f"{BALANCE}?app_version={ver}"
    req = urllib.request.Request(url, headers=headers(token, mid, ver))
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:300]}
    except Exception as e:
        return -1, {"_err": str(e)}


def ts(sec):
    if not sec:
        return "-"
    return datetime.fromtimestamp(int(sec), CST).strftime("%m-%d %H:%M")


def main():
    files = sorted(ACCT_DIR.glob("*.json"))
    print(f"账号目录: {ACCT_DIR}  共 {len(files)} 个号\n")
    summary = []
    for f in files:
        acc = json.loads(f.read_text(encoding="utf-8"))
        aid = acc.get("id", f.stem)
        name = acc.get("name", f.stem)
        tok = dec(acc.get("credentials", {}).get("zcodejwttoken", "") or "")
        mid = acc.get("virtual_device_mid")
        if not tok:
            print(f"=== {name} ({aid[:8]}) —— 无 JWT，跳过")
            summary.append((name, "NO_TOKEN"))
            continue
        code, v = fetch_balance(tok, mid, VER)
        if code != 200:
            print(f"=== {name} ({aid[:8]}) HTTP={code} resp={json.dumps(v, ensure_ascii=False)[:200]}")
            summary.append((name, f"HTTP{code}"))
            continue
        data = v.get("data") or {}
        plans = data.get("plans") or []
        balances = data.get("balances") or []
        if not plans:
            print(f"=== {name} ({aid[:8]}) —— 无任何套餐（plans=[]）")
            summary.append((name, "无套餐"))
            continue
        # 关注 plan-1117 / GLOBAL BUILD 的生命周期状态
        p1117 = [p for p in plans if "1117" in (p.get("plan_id") or "")]
        bits = []
        for p in plans:
            pid = p.get("plan_id")
            st = p.get("status")
            eff = ts(p.get("starts_at"))
            end = ts(p.get("ends_at"))
            tag = " <1117>" if "1117" in (pid or "") else ""
            bits.append(f"{pid}{tag}[{st} {eff}→{end}]")
        # 1117 的余额
        rem = "-"
        for b in balances:
            if "1117" in (b.get("plan_id") or ""):
                ru = b.get("remaining_units")
                au = b.get("available_units")
                rem = f"remaining={ru} available={au}"
                break
        status = "1117:" + (p1117[0].get("status") if p1117 else "无")
        print(f"=== {name} ({aid[:8]})  {status}  {rem}")
        for x in bits:
            print(f"      {x}")
        summary.append((name, status))
    print("\n===== 汇总（是否持有 plan-1117 及其 status）=====")
    for n, s in summary:
        print(f"  {n:<24} {s}")


if __name__ == "__main__":
    main()
