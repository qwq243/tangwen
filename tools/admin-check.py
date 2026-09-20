#!/usr/bin/env python3
"""后台回归：埋点聚合 + 登录 + 鉴权 + 排行榜删档，全套打一遍。

用法：python tools/admin-check.py

自己在一个空目录里起 server.py（端口 8791、DATA_DIR 指到临时目录），
所以不会碰真数据、不用先把服务开着。测完关掉，退出码非 0 表示有用例没过。

判题与求灯在这一次启动里被换成桩（见 JUDGE_STUB）：记账的用例必须离线可重复，
而且「判题挂了也要记下这一问」这条语义只有能让判题挂掉才测得出来。

为什么这些用例值得留着：后台的错都是「静默」的 —— 密钥比错了照常返回 200、
token 不校验签名照样能读数据、UV 不去重数字只是偏大、埋点少记一笔没人报错。
这些都不会报错，只能靠断言钉住。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"
KEY = "test-admin-key-0123456789abcdef"  # 只在本进程的临时环境里用
OUT = ROOT / "tmp" / "_o_admin-check.txt"

# 启动器：import server 之后把两个要联网的函数换成桩，再照原样 main()。
# 为什么不改 server.py 加个开关 —— 测试的机关不该长在生产代码里。
# 判题桩按 questions 里带的 key_* 逐条给满分 => 每个关键点都问到 => 判成结案；
# 求灯桩直接回一句固定文本（真求灯要打 Workers AI，离线时会退兜底，不稳定）。
JUDGE_STUB = '''# -*- coding: utf-8 -*-
import sys

sys.path.insert(0, r"{root}")
import server


def fake_typesafe(state, questions):
    # 问题里带「桩-崩」就当作上游挂了：用来验「判题失败也要记下这一问」
    if "桩-崩" in str(state.get("player_utterance") or ""):
        raise RuntimeError("stub judge down")
    answers = {{
        "trying_to_extract": {{"noul": 0.0}},
        "is_full_guess": {{"noul": 0.0}},
        "guess_correct": {{"noul": 0.0}},
        "host_answer": {{"choice": "no", "confidence": 0.9,
                         "probabilities": {{"no": 0.9, "yes": 0.05}}}},
    }}
    for name in questions:
        if name.startswith("key_"):
            answers[name] = {{"noul": 1.0}}
    return {{"answers": answers, "model": "stub", "usage": {{}}}}, 12.0


def fake_hint(puzzle, history, unlocked, prev=""):
    return "（桩）提示", "stub"


server.typesafe = fake_typesafe
server.make_hint = fake_hint
server.main()
'''

fails: list[str] = []
lines: list[str] = []


def ok(name: str, cond: bool, extra: str = "") -> None:
    lines.append(("[OK]  " if cond else "[FAIL]") + f" {name}" + (f"   {extra}" if extra else ""))
    if not cond:
        fails.append(name)


def call(path: str, method: str = "GET", body=None, token: str = "", timeout: int = 20):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            ctype = r.headers.get("Content-Type", "")
            return r.status, raw, ctype
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


def jcall(path: str, method: str = "GET", body=None, token: str = ""):
    status, raw, _ = call(path, method, body, token)
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:
        return status, {"_raw": raw[:200].decode("utf-8", "replace")}


def mint(exp_offset_ms: int) -> str:
    """按 server.py 的算法自己签一个 token —— 用来测过期和签名被改两种情况。"""
    payload = base64.urlsafe_b64encode(
        json.dumps({"exp": int(time.time() * 1000) + exp_offset_ms}).encode()
    ).decode("ascii").rstrip("=")
    sig = hmac.new(KEY.encode(), payload.encode(), hashlib.sha256).digest()
    return payload + "." + base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")


def stats_now(token: str) -> tuple[dict, dict]:
    """今天那一行 + 分卷明细（按卷 id 索引）。

    比增量，不写死绝对值 —— 以后往前加用例时，前面记的那几笔不会把后面的断言带歪。"""
    _, s = jcall("/api/admin/stats?days=7", token=token)
    today = (s.get("days") or [{}])[-1]
    puz = {r.get("id"): r for r in (s.get("puzzles") or [])}
    return today, puz


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="tangwen-admin-"))
    python = sys.executable
    env = dict(os.environ)
    env.update({"PORT": str(PORT), "HOST": "127.0.0.1", "DATA_DIR": str(tmp / "data"), "ADMIN_KEY": KEY})
    # 判题与求灯都在启动器里换成桩了；密钥再清一遍，这样「桩没生效」只表现为用例挂，
    # 不会退化成测试期间真去打外部接口。
    env["TYPESAFE_API_KEY"] = ""
    env["PYTHONUTF8"] = "1"   # 启动器与 server.py 的源码都是 UTF-8，别让区域设置插一脚
    env.pop("CHAT_API_KEY", None)
    launcher = tmp / "server_stub.py"
    launcher.write_text(JUDGE_STUB.format(root=ROOT), encoding="utf-8")
    proc = subprocess.Popen(
        [python, str(launcher)],
        cwd=str(ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # 1. 等就绪
        ready = False
        for _ in range(60):
            try:
                if call("/api/health", timeout=2)[0] == 200:
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if not ready:
            lines.append("[FAIL] 服务起不来")
            print("\n".join(lines))
            return 1
        lines.append("[OK]  服务就绪 " + BASE)

        # 2. health 暴露了新字段
        st, h = jcall("/api/health")
        ok("health 带 stats / admin / hint_model",
           st == 200 and h.get("stats") is True and h.get("admin") is True and "hint_model" in h,
           json.dumps(h, ensure_ascii=False)[:180])

        # 3. 未登录一律拦
        st, _ = jcall("/api/admin/stats")
        ok("无 token 读 stats 被拦", st == 401, f"HTTP {st}")
        st, _ = jcall("/api/admin/puzzles", token="garbage")
        ok("瞎编 token 读卷宗被拦", st == 401, f"HTTP {st}")
        st, _ = jcall("/api/admin/stats", token=mint(-60_000))
        ok("过期 token 被拦", st == 401, f"HTTP {st}")
        good = mint(600_000)
        st, _ = jcall("/api/admin/stats", token=good[:-2] + ("AA" if good[-2:] != "AA" else "BB"))
        ok("签名被改一位即失效", st == 401, f"HTTP {st}")

        # 4. probe 不需要登录
        st, p = jcall("/api/admin/probe")
        ok("probe 无需登录且报 configured", st == 200 and p.get("configured") is True, str(p))

        # 5. 登录
        st, d = jcall("/api/admin/login", "POST", {"key": "wrong-key"})
        ok("错密钥 401 且给出剩余次数", st == 401 and d.get("left") == 7, json.dumps(d, ensure_ascii=False))
        st, d = jcall("/api/admin/login", "POST", {"key": KEY})
        token = d.get("token", "")
        ok("对密钥发 token", st == 200 and bool(token) and d.get("ttl_ms") == 12 * 3600 * 1000,
           f"HTTP {st} len={len(token)}")
        st, d = jcall("/api/admin/login", "POST", {"key": KEY})
        ok("成功后失败计数被清掉", st == 200 and d.get("left") is None, str(d.get("left")))

        # 6. 埋点：客户端现在只报 pv，别的 k 一概不认
        #    （认了就跟下面第 9 条里服务端自己数的那份重复计 —— 旧客户端还在报 give）
        st, d = jcall("/api/track", "POST", {
            "uid": "u-aaaaaa-1111",
            "events": [{"k": "pv"}, {"k": "pv"}, {"k": "ask", "p": "jumper"},
                       {"k": "ask", "p": "jumper"}, {"k": "hint", "p": "jumper"},
                       {"k": "solve", "p": "jumper"}, {"k": "give", "p": "jumper"}],
        })
        ok("埋点接收", st == 200 and d.get("ok") and d.get("n") == 7 and d.get("new") is True,
           json.dumps(d, ensure_ascii=False))
        st, s = jcall("/api/admin/stats?days=7", token=token)
        today = (s.get("days") or [{}])[-1]
        ok("只认 pv：客户端报的 ask/hint/solve/give 一律不计（新老前端混跑不会记双）",
           today.get("pv") == 2 and today.get("ask") == 0 and today.get("hint") == 0
           and today.get("solve") == 0 and today.get("give") == 0 and today.get("uv") == 1,
           json.dumps(today, ensure_ascii=False))
        ok("客户端上报不写分卷明细（分卷只由接口自己记）", (s.get("puzzles") or []) == [],
           json.dumps(s.get("puzzles"), ensure_ascii=False))

        # 7. UV 去重 / 新增判定
        jcall("/api/track", "POST", {"uid": "u-aaaaaa-1111", "events": [{"k": "pv"}]})
        st, s = jcall("/api/admin/stats?days=7", token=token)
        today = (s.get("days") or [{}])[-1]
        ok("同一 uid 再来不算新访客也不重复计 UV", today.get("uv") == 1 and today.get("new") == 1
           and today.get("pv") == 3, json.dumps(today, ensure_ascii=False))
        jcall("/api/track", "POST", {"uid": "u-bbbbbb-2222", "events": [{"k": "pv"}]})
        st, s = jcall("/api/admin/stats?days=7", token=token)
        today = (s.get("days") or [{}])[-1]
        ok("换一个 uid 记 UV+1 与新增+1", today.get("uv") == 2 and today.get("new") == 2,
           json.dumps(today, ensure_ascii=False))

        # 8. 脏数据不该把埋点搞崩
        st, d = jcall("/api/track", "POST", {"events": [{"k": "nonsense"}, {"k": "pv"}]})
        ok("未知事件名被忽略、请求仍成功", st == 200 and d.get("n") == 2, json.dumps(d, ensure_ascii=False))
        st, d = jcall("/api/track", "POST", {"uid": "短", "events": [{"k": "pv"}]})
        ok("非法 uid 被丢弃（只记事件不记人）", st == 200 and d.get("new") is False,
           json.dumps(d, ensure_ascii=False))
        st, _ = jcall("/api/track", "POST", {"uid": "u-aaaaaa-1111", "events": []})
        ok("空事件直接跳过", st == 200, f"HTTP {st}")

        # 8b. 接口自己数：ask / hint / solve / give 不再等客户端上报。
        #     2026-09-20 线上后台 ask=0 的根因就是这四档原先全靠前端报，
        #     而线上那份 app.js 是旧的 —— 服务端当场看得见的事，就得服务端自己记。
        base_today, _ = stats_now(token)
        st, a = jcall("/api/ask", "POST", {"puzzle_id": "jumper", "question": "他是自杀的吗？"})
        ok("判题桩生效：这一问判成结案",
           st == 200 and a.get("ok") is True and a.get("solved") is True,
           json.dumps({"http": st, "solved": a.get("solved"), "label": a.get("label")}, ensure_ascii=False))
        st, g = jcall("/api/giveup", "POST", {"puzzle_id": "jumper"})
        ok("放弃照旧返回汤底", st == 200 and bool(g.get("bottom")), f"HTTP {st}")
        st, h = jcall("/api/hint", "POST", {"puzzle_id": "jumper", "history": [], "unlocked": []})
        ok("求灯照旧返回提示", st == 200 and h.get("ok") is True, json.dumps(h, ensure_ascii=False)[:120])

        today, puz = stats_now(token)
        ok("接口自己数：ask / solve / hint / give 各 +1",
           today.get("ask") == base_today.get("ask", 0) + 1
           and today.get("solve") == base_today.get("solve", 0) + 1
           and today.get("hint") == base_today.get("hint", 0) + 1
           and today.get("give") == base_today.get("give", 0) + 1,
           json.dumps(today, ensure_ascii=False))
        ok("这一轮没人报 pv，pv 就不动（两条路没串）",
           today.get("pv") == base_today.get("pv"), f"pv={today.get('pv')}")
        row = puz.get("jumper") or {}
        ok("分卷明细由接口自己记：jumper 上 ask/solve/hint 各 1",
           row.get("ask") == 1 and row.get("solve") == 1 and row.get("hint") == 1,
           json.dumps(row, ensure_ascii=False))

        # 8c. 判题挂了也照样算一问：玩家确实问了，模型挂掉不该让这一笔消失
        #     （反过来才危险：判题超时的那段时间后台看起来「没人提问」）
        st, _ = jcall("/api/ask", "POST", {"puzzle_id": "jumper", "question": "桩-崩 一下看看"})
        today2, _ = stats_now(token)
        ok("判题失败（500）仍记 ask、不记 solve",
           st == 500 and today2.get("ask") == base_today.get("ask", 0) + 2
           and today2.get("solve") == base_today.get("solve", 0) + 1,
           json.dumps({"http": st, "ask": today2.get("ask"), "solve": today2.get("solve")}, ensure_ascii=False))
        st, d = jcall("/api/ask", "POST", {"puzzle_id": "jumper", "question": "  "})
        ok("空问题 / 不存在的卷不算提问", st == 400 and stats_now(token)[0].get("ask") == base_today.get("ask", 0) + 2,
           f"HTTP {st}")

        # 9. 卷宗核对能拿到汤底
        st, v = jcall("/api/admin/puzzles", token=token)
        first = (v.get("puzzles") or [{}])[0]
        ok("后台能拿到全部卷宗与汤底", st == 200 and len(v.get("puzzles") or []) > 20
           and bool(first.get("bottom")) and isinstance(first.get("keys"), list),
           f"{len(v.get('puzzles') or [])} 卷, 首卷 keys={len(first.get('keys') or [])}")
        # 汤色也要跟着出来：后台「卷宗核对」就是核对分类的地方（口径 tools/soup.py），
        # 缺了这一栏就没法在后台一眼扫过全库看有没有判错的
        soups = [p.get("soup") for p in (v.get("puzzles") or [])]
        ok("后台卷宗带汤色，且每卷都落在三档里",
           bool(soups) and all(s in ("清汤", "红汤", "黑汤") for s in soups),
           f"{len(soups)} 卷: " + json.dumps({s: soups.count(s) for s in sorted(set(soups))},
                                            ensure_ascii=False))

        # 10. 排行榜删档
        jcall("/api/score", "POST", {"puzzle_id": "jumper", "id": "p1", "name": "甲", "asks": 3, "ms": 60000})
        jcall("/api/score", "POST", {"puzzle_id": "jumper", "id": "p2", "name": "乙", "asks": 5, "ms": 90000})
        st, b = jcall("/api/admin/board?puzzle_id=jumper", token=token)
        ok("读到排行榜", st == 200 and len(b.get("rows") or []) == 2, f"rows={len(b.get('rows') or [])}")
        st, b = jcall("/api/admin/board/delete", "POST", {"puzzle_id": "jumper", "id": "p1"}, token=token)
        ok("删掉指定的一条", st == 200 and b.get("removed") == 1 and len(b.get("rows") or []) == 1,
           json.dumps({"removed": b.get("removed"), "left": len(b.get("rows") or [])}, ensure_ascii=False))
        st, _ = jcall("/api/admin/board/delete", "POST", {"puzzle_id": "jumper", "id": "nope"}, token=token)
        ok("删不存在的行报 404", st == 404, f"HTTP {st}")
        st, _ = jcall("/api/admin/board/delete", "POST", {"puzzle_id": "不存在的卷", "id": "p1"}, token=token)
        ok("卷 id 不存在报 404", st == 404, f"HTTP {st}")
        st, _ = jcall("/api/admin/board/delete", "POST", {"puzzle_id": "jumper", "id": "p1"})
        ok("删档也要 token", st == 401, f"HTTP {st}")
        st, b = jcall("/api/admin/board/clear", "POST", {"puzzle_id": "jumper"}, token=token)
        ok("清空本卷", st == 200 and b.get("removed") == 1 and b.get("rows") == [],
           json.dumps(b, ensure_ascii=False))

        # 11. 登录限流：错满 8 次锁住
        codes = []
        for _ in range(9):
            codes.append(jcall("/api/admin/login", "POST", {"key": "still-wrong"})[0])
        ok("错满 8 次后第 9 次被限流", codes[:8] == [401] * 8 and codes[8] == 429, str(codes))
        st, _ = jcall("/api/admin/login", "POST", {"key": KEY})
        ok("限流期间对的密钥也进不去（防爆破优先）", st == 429, f"HTTP {st}")

        # 12. 后台页面本身
        st, raw, ctype = call("/admin/")
        html = raw.decode("utf-8", "replace")
        ok("/admin/ 能打开且是 HTML", st == 200 and "text/html" in ctype and "账" in html,
           f"HTTP {st} {len(raw)}B")
        st, raw, _ = call("/admin/admin.js")
        ok("/admin/admin.js 能拿到", st == 200 and b"/api/admin/stats" in raw, f"HTTP {st}")
        st, raw, _ = call("/admin/admin.css")
        ok("/admin/admin.css 能拿到", st == 200 and b".kpi" in raw, f"HTTP {st}")

        # 13. 首页版本号跟上：四处 ?v= 必须同号（不同号=只改了一半，缓存必炸）。
        #     并行会话可能随时再 bump，所以只要求「一致且不低于 19」，不写死具体号。
        st, raw, _ = call("/")
        html = raw.decode("utf-8", "replace")
        vs = sorted(set(re.findall(r"\?v=(\d+)", html)))
        ok("首页版本号四处一致且不是旧版", len(vs) == 1 and int(vs[0]) >= 19,
           f"?v={vs}")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    lines.append("")
    lines.append(f"用例 {len(lines) - 1} 条，失败 {len(fails)} 条")
    if fails:
        lines.append("失败项：" + "、".join(fails))
    else:
        lines.append("[OK] 全部通过")
    text = "\n".join(lines)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(text)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
