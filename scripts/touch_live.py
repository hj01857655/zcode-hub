#!/usr/bin/env python3
# touch_live.py — 用当前 Rust 逻辑（claim.rs touch_plans）原样打 marketing/touch，
# 验证「现在的代码能不能查出投放」。与旧 touch_probe.py 的差别：
#   1) app_version 走探测真实版本（quota.rs zcode_app_version 已恢复注册表探测——
#      11-03 订正：投放端点按 app_version 过滤，3.16.3 全空 / 3.17.2 见投放，
#      对照实锤见 git log quota.rs）
#   2) 投放扫描双壳：banner.buttons 与 delivery.buttons 都看（popup 壳不再漏）
#   3) zcode_plan 四路径取值，与 /data/deliveries 形状错误上抛
# 同时打印每条投放的原始骨架（resource_position / action.type 列表），便于对照归因。
# 用法：python scripts/touch_live.py [--id <account_id>] [--ver 3.17.2]
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from farm_probe import dec, os_version  # 复用解密 / OS 版本探测（同构 Rust os_version）

HOME = Path.home()
SWITCH_DIR = HOME / ".zcode-switch"
TOUCH = "https://zcode.z.ai/api/v1/marketing/touch"
SAFE_APP_VERSION = "3.17.2"  # 与本机注册表探测值一致（quota.rs zcode_app_version 恢复探测后同源）
import ssl

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


def touch_once(token, mid, ver, seq):
    url = f"{TOUCH}?seq={seq}&app_version={ver}&platform=win32-x64"
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


def scan(d):
    """镜像 touch_plans 的按钮扫描：banner.buttons + delivery.buttons 双壳。"""
    wanted, seen = [], set()
    for node in filter(None, [d.get("banner"), d]):
        for b in node.get("buttons") or []:
            act = b.get("action") or {}
            if act.get("type") != "claim_zcode_plan":
                continue
            args = act.get("args") or {}
            pid = (args.get("plan_id") or args.get("planId") or "").strip()
            if pid and pid not in seen:
                seen.add(pid)
                wanted.append(pid)
    return wanted


def zp_paths(d):
    return [
        d.get("banner", {}).get("background", {}).get("args", {}).get("zcode_plan")
        if isinstance(d.get("banner"), dict) else None,
        d.get("banner", {}).get("background", {}).get("bundle", {}).get("args", {}).get("zcode_plan")
        if isinstance(d.get("banner"), dict) else None,
        d.get("background", {}).get("args", {}).get("zcode_plan")
        if isinstance(d.get("background"), dict) else None,
        d.get("background", {}).get("bundle", {}).get("args", {}).get("zcode_plan")
        if isinstance(d.get("background"), dict) else None,
    ]


def main():
    only = None
    ver = SAFE_APP_VERSION
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--id" and i + 1 < len(args):
            only = args[i + 1]
        if a == "--ver" and i + 1 < len(args):
            ver = args[i + 1]
    seq = 0
    for f in sorted(SWITCH_DIR.glob("accounts/*.json")):
        acc = json.loads(f.read_text(encoding="utf-8"))
        aid = acc.get("id", f.stem)
        if only and aid != only:
            continue
        name = acc.get("name", f.stem)
        tok = dec(acc.get("credentials", {}).get("zcodejwttoken", "") or "")
        mid = acc.get("virtual_device_mid")
        seq += 1
        code, v = touch_once(tok, mid, ver, seq)
        print(f"=== {name} ({aid}) mid={mid} ver={ver} HTTP={code}")
        if code != 200:
            print("    resp:", json.dumps(v, ensure_ascii=False)[:400])
            continue
        data = v.get("data") or {}
        dels = data.get("deliveries")
        if dels is None:
            print("    形状异常：无 /data/deliveries（Rust 侧此处 Err touch_shape）")
            print("    data keys:", list(data.keys()) if isinstance(data, dict) else type(data).__name__)
            continue
        print(f"    deliveries={len(dels)}")
        total_claim = []
        for i, d in enumerate(dels):
            pos = d.get("resource_position") or d.get("resourcePosition")
            camp = d.get("campaign_id") or d.get("campaignId")
            btn_nodes = []
            for src, node in (("root", d), ("banner", d.get("banner") if isinstance(d.get("banner"), dict) else None)):
                if not node:
                    continue
                for b in node.get("buttons") or []:
                    act = b.get("action") or {}
                    btn_nodes.append(f"{src}:{act.get('type')}")
            wanted = scan(d)
            zps = [p for p in zp_paths(d) if isinstance(p, dict)]
            print(f"    [{i}] pos={pos} camp={camp} buttons={btn_nodes} claim_ids={wanted} zcode_plan={len(zps)}")
            if zps:
                p = zps[0]
                print(f"         plan_id={p.get('plan_id') or p.get('planId')} name={p.get('name')} prio={p.get('priority')}")
            total_claim += wanted
        print(f"    >>> 当前代码解析出的可领 plan_id: {total_claim or '（空 → UI 显示「资格已刷新 · 暂无可领套餐」）'}")


if __name__ == "__main__":
    main()
