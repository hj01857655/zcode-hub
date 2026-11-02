#!/usr/bin/env python3
# 只探两个裸号的 billing/claim 返回码（假验证码，最坏一个错误码）
import json, sys, ssl, urllib.request, urllib.error, uuid
sys.path.insert(0, "E:/VSCodeSpace/Agent/ZCode/zcode-switch/scripts")
from farm_probe import farm_members, headers_for  # 无扫描副作用，纯函数

CLAIM = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim"
TARGETS = {"hjj09903@gmail.com", "1292548381@qq.com"}
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

for m in farm_members():
    if m["name"] not in TARGETS:
        continue
    h = headers_for(m["token"], m["mid"], "3.17.1")
    h["X-Aliyun-Captcha-Verify-Param"] = "probe.invalid.probe"
    req = urllib.request.Request(CLAIM, method="POST",
        data=json.dumps({"plan_id": "zcode-v3-start-plan-1102"}).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            v = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try: v = json.loads(e.read().decode("utf-8", "replace"))
        except Exception: v = {"code": f"HTTP{e.code}"}
    except Exception as e:
        v = {"code": "NETERR", "msg": str(e)[:60]}
    print(f"{m['name']:<14} code={v.get('code')}  msg={str(v.get('msg',''))[:70]}")
