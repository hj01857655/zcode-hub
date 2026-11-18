#!/usr/bin/env python3
# ttl_probe.py — 单号密集 touch 测投放寿命（TTL 判别实验）。
# 原理：touch 为 GET 轮询、无副作用（2026-11-12 单变量实验验证，CLAIM-FLOW.md §9）。
# 窗口开时对一个号按 gap 秒间隔连续 touch，记录 deliveries=1 → 0 的翻转时刻，
# 与领取动作完全解耦——翻转时刻即投放寿命（或回收时刻），排除领取节奏混淆。
#
# 两种自转模式：
#   等窗（默认）：30s 慢轮询直到首次 deliveries=1（窗口开、投放签发），随后切 gap 秒密集轮询；
#   --now：跳过等窗直接密集轮询（已在窗口内手工启动时用）。
# 终止：翻转后打印 FLIP 行退出；或 --max 秒上限到时退出。
#
# 用法：python scripts/ttl_probe.py --id <账号id前缀> [--gap 5] [--max 900] [--now]
# 输出：每行 "时刻 账龄s deliveries server_time"，FLIP 行给出翻转账龄。
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from farm_probe import dec, os_version

HOME = Path.home()
ACCT_DIR = HOME / ".zcode-hub" / "accounts"
TOUCH = "https://zcode.z.ai/api/v1/marketing/touch"
VER = "3.17.1"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def headers(token, mid, ver):
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
    }
    if mid:
        h["X-Device-Mid"] = mid
    if (ov := os_version()):
        h["X-Os-Version"] = ov
    return h


def touch_once(token, mid, seq):
    url = f"{TOUCH}?seq={seq}&app_version={VER}&platform=win32-x64"
    req = urllib.request.Request(url, headers=headers(token, mid, seq))
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:200]}
    except Exception as e:
        return -1, {"_err": str(e)}


def deliveries_count(v):
    d = (v.get("data") or {}).get("deliveries")
    return None if d is None else len(d)


def find_account(prefix):
    for f in sorted(ACCT_DIR.glob("*.json")):
        if f.stem.startswith(prefix):
            return json.loads(f.read_text(encoding="utf-8"))
    raise SystemExit(f"未找到账号：{prefix}（ACCT_DIR={ACCT_DIR}）")


def main():
    args = sys.argv[1:]
    prefix, gap, max_s, now = None, 5, 900, False
    for i, a in enumerate(args):
        if a == "--id" and i + 1 < len(args):
            prefix = args[i + 1]
        elif a == "--gap" and i + 1 < len(args):
            gap = int(args[i + 1])
        elif a == "--max" and i + 1 < len(args):
            max_s = int(args[i + 1])
        elif a == "--now":
            now = True
    if not prefix:
        raise SystemExit("用法：python scripts/ttl_probe.py --id <账号id前缀> [--gap 5] [--max 900] [--now]")

    acc = find_account(prefix)
    name = acc.get("name", "?")
    tok = dec(acc.get("credentials", {}).get("zcodejwttoken", "") or "")
    mid = acc.get("virtual_device_mid")
    if not tok:
        raise SystemExit(f"{name}: 无 zcodejwttoken")

    print(f"目标：{name} ({acc.get('id','')[:8]})  gap={gap}s  max={max_s}s  模式={'直接密集' if now else '等窗→密集'}")
    print("时刻        账龄s  deliveries  server_time  HTTP")
    t0 = time.monotonic()
    issued_at = None
    seq = 0
    flipping_seen = False
    while (time.monotonic() - t0) < max_s:
        seq += 1
        code, v = touch_once(tok, mid, seq)
        n = deliveries_count(v)
        st = (v.get("data") or {}).get("server_time", "-")
        age = f"{time.monotonic() - issued_at:5.1f}" if issued_at else "  -  "
        print(f"{datetime.now().strftime('%H:%M:%S')}  {age}  {n}  {st}  {code}", flush=True)
        if n is None or code != 200:
            print(f"  !! 异常响应：{json.dumps(v, ensure_ascii=False)[:200]}")
        elif n and n > 0 and issued_at is None:
            issued_at = time.monotonic()
            print(f"  >>> 投放签发（首次 deliveries={n}），切密集轮询 {gap}s", flush=True)
        elif issued_at is not None and (n == 0):
            flipping_seen = True
            age_f = time.monotonic() - issued_at
            print(f"\nFLIP: 投放在签发后 {age_f:.1f}s 翻转为 0（TTL/回收观测值，账龄精度 ±{gap}s）", flush=True)
            break
        # 等窗阶段 30s 慢轮询；签发后按 gap 密集
        time.sleep(gap if issued_at or now else 30)
    if not flipping_seen and issued_at is None:
        print("\n超时：窗口未开（max 秒内未见投放）", flush=True)
    elif not flipping_seen:
        print(f"\n超时：投放签发后 {max_s}s 内未翻转（寿命 > 观测窗，倾向存量+回收假设）", flush=True)


if __name__ == "__main__":
    main()
