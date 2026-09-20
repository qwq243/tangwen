#!/usr/bin/env python3
"""全库身份题回归：逐卷拿 cast 里写定的人，问「是男的吗 / 是女的吗」，看印落得对不对。

这是 `tools/cast.py` 那张人物表的验收测试，钉子只有两颗：

  1. **写定的不许是软档**。cast 写「男」，问「X 是女的吗」必须落「不是」；
     落「不重要 / 无关 / 问清楚点」就是这一卷又回到「男女都答不重要」的老毛病
     （2026-09-20 用户报的《怀孕》就是这个：爱人是男的吗 → unimportant .65 / yes .23，
     同一问连打三次在「是」与「不重要」之间抖）。
  2. **没写定的要明确说没写**。cast 标「未写明」，两个方向都该落「不重要」；
     落「是 / 不是」就是模型在替材料编性别。

顺带量一个实现细节：`state` 的字段顺序真的会改判题结果 —— 同一份 state 只在
cast 的位置上不同（facts 后面 vs 末尾），《怀孕》的「怀孕的是爱人吗」一边稳定
答「是」一边稳定答「不是」（交错 4 轮 4:4，见 tmp/_order_ab.py）。所以这里把
顺序做成参数（--order last|mid），**默认 last 就是线上口径**（server.py 与
functions 里 cast 都排在末尾）。

用法：
    python tools/cast-check.py                 # 全库，两个方向都问
    python tools/cast-check.py --quick         # 每卷只挑一条写定的人，快跑
    python tools/cast-check.py --order mid      # 对照：cast 放到 facts 后面
    python tools/cast-check.py --ids pregnancy rental
    python tools/cast-check.py --workers 6 --repeat 2
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 期望表：写定男/女 → 正向该「是」、反向该「不是」；未写明 → 两个方向都该是软档
CORE = ("是",)                      # 方向对：写男问男
CORE_INV = ("不是",)                 # 方向反：写男问女
SOFT = ("不重要", "无关")            # 没写定：明说没写
AMBIG = ("是也不是", "部分对", "接近了")   # 两可档：算过，但记下来复看


def load_server(order: str, no_cast: bool = False):
    """按真实判题路径跑：导入 server.py，只把 typesafe 包一层来调字段顺序 / 去掉 cast。

    包 typesafe 而不是自己拼 state —— 这样测的是 judge() 真正发出去的那份 payload，
    不会被探针自己抄错。
    """
    os.environ.setdefault("DATA_DIR", str(ROOT / "tmp" / "_castcheck-data"))
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("srv_castcheck", ROOT / "server.py")
    srv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srv)

    real = srv.typesafe

    def wrapped(state: dict, questions: dict):
        if no_cast:
            state = {k: v for k, v in state.items() if k != "cast"}
        elif order == "last" and "cast" in state:
            rest = {k: v for k, v in state.items() if k != "cast"}
            rest["cast"] = state["cast"]
            state = rest
        return real(state, questions)

    srv.typesafe = wrapped
    return srv


def strip_parens(name: str) -> str:
    return re.sub(r"（[^）]*）", "", name).strip() or name


def check_parity(srv) -> list[str]:
    """两条链路（server.py / functions/api/[[path]].js）的判题口径必须逐字一致。

    这里不是全量 diff，只钉两件真会出事、而且肉眼最容易漏的：

      1. **说明的正文**：Python 那份 host_answer 的每一条文字，都要能在 JS 里原样找到
         —— 只改一边，线上和本地就会对不同的问题给不同的印；
      2. **state 的字段顺序**：cast 排在哪一位是量出来的（见下面的 --order），
         两边顺序不一样等于两个模型。tools/cast.py 只管数据，管不到这个。
    """
    js_path = ROOT / "functions" / "api" / "[[path]].js"
    src = js_path.read_text(encoding="utf-8")
    errs: list[str] = []
    # 两份 puzzles.json 必须逐字节一致：线上 import 的是 functions/puzzles.json，
    # 本地读的是根目录那份，不一致就是本地一套、线上一套。
    if (ROOT / "puzzles.json").read_bytes() != (ROOT / "functions" / "puzzles.json").read_bytes():
        errs.append("puzzles.json 与 functions/puzzles.json 不一致（跑 tools/cast.py --write 同步）")
    host = srv.BASE_QUESTIONS["host_answer"]
    for key, val in host["instructions"].items():
        if key == "role":
            continue          # role 是 bundle 里的 HOST_ROLE，JS 那边是引用，不在源码里
        texts = [val] if isinstance(val, str) else list(val.values())
        for t in texts:
            if t and t not in src:
                errs.append(f"instructions.{key} 的一段话在 JS 里找不到（两边口径不一致）")
    for key, val in host["criteria"].items():
        if val not in src:
            errs.append(f"criteria.{key} 在 JS 里找不到（两边口径不一致）")
    if "identity:" not in src:
        errs.append("JS 的 host_answer 里没有 identity 那一条")

    def keys_of(text: str, start: str, stop: str) -> list[str]:
        i = text.find(start)
        if i < 0:
            return []
        j = text.find(stop, i)
        seg = text[i:j if j > 0 else len(text)]
        return [m.group(1) for m in re.finditer(r'^\s*"?([a-z_]+)"?\s*:', seg, re.M)]

    py_src = (ROOT / "server.py").read_text(encoding="utf-8")
    py_order = keys_of(py_src, '"title": puzzle["title"]', "\n    }")
    js_order = keys_of(src, "title: puzzle.title", "};")
    if py_order != js_order:
        errs.append(f"state 字段顺序两边不一样：py={py_order} js={js_order}")
    return errs


def subject(name: str) -> str:
    """把 cast 里的名字变成玩家会用的说法。"""
    s = strip_parens(name)
    s = s.split("、")[0]                      # 「老大、老三、老五等」→「老大」
    s = s.replace("（汤面）", "").strip()
    if s in ("我", "我 "):
        return "叙述者"
    return s


def question_for(name: str, sex: str) -> str:
    who = subject(name)
    return f"{who}是男的吗" if sex == "男" else f"{who}是女的吗"


def probe_one(srv, pid: str, entry: dict, ask_male: bool, repeat: int) -> list[dict]:
    """问一条 cast：ask_male=True 问「是男的吗」，否则问「是女的吗」。"""
    name, sex = entry["name"], entry["sex"]
    q = (f"{subject(name)}是男的吗" if ask_male else f"{subject(name)}是女的吗")
    rows = []
    for _ in range(repeat):
        try:
            r = srv.judge(srv.PUZZLES[pid], q, [], [])
        except Exception as e:                                    # noqa: BLE001
            rows.append({"pid": pid, "entry": name, "sex": sex, "q": q,
                         "label": "调用失败", "verdict": "error", "note": str(e)[:60],
                         "probs": {}})
            continue
        j = r.get("judge") or {}
        rows.append({"pid": pid, "entry": name, "sex": sex, "q": q,
                     "label": r.get("label"), "verdict": r.get("verdict"),
                     "note": "", "probs": j.get("probabilities") or {}})
    return rows


def verdict_of(row: dict, expect: tuple[str, ...]) -> str:
    """ok / ambiguous / bad / error"""
    if row["verdict"] == "error":
        return "error"
    if row["verdict"] == "solved":
        return "bad"
    if row["label"] in expect:
        return "ok"
    if row["label"] in AMBIG:
        return "ambiguous"
    return "bad"


# 跨阶段条目（双性人 / 手术改造 / 一群人）没法用「是男还是女」机械断言 —— 但也不能
# 空着不收。这里是逐条手工定的期望，跟别的条目一起回归。
SPECIAL_CASES = [
    ("letter", "我是双性人、27 岁手术后外观为男", [
        ("叙述者是男的吗", ("是也不是", "部分对")),
        ("叙述者原来是女的吗", ("是", "是也不是", "部分对")),
    ]),
    ("diary", "我（出生男 → 11 岁起为女）", [
        ("叙述者是男的吗", ("是也不是", "部分对")),
        ("叙述者被改造成女孩了吗", ("是",)),
    ]),
    ("asylum", "童谣只收女人和小孩", [
        ("院子里挂的是女人和小孩吗", ("是", "部分对")),
        ("院子里挂着的有老人吗", ("不是",)),
    ]),
]


def probe_special(srv, pid: str, note: str, cases: list[tuple[str, tuple[str, ...]]],
                  repeat: int) -> list[dict]:
    """跨阶段条目的显式用例：问法与可接受的印面都手写。"""
    rows = []
    for q, expect in cases:
        for _ in range(repeat):
            try:
                r = srv.judge(srv.PUZZLES[pid], q, [], [])
            except Exception as e:                                    # noqa: BLE001
                rows.append({"pid": pid, "entry": note, "sex": "跨阶段", "q": q,
                             "label": "调用失败", "verdict": "error", "note": str(e)[:60],
                             "probs": {}, "expect": expect})
                continue
            j = r.get("judge") or {}
            rows.append({"pid": pid, "entry": note, "sex": "跨阶段", "q": q,
                         "label": r.get("label"), "verdict": r.get("verdict"),
                         "note": "", "probs": j.get("probabilities") or {}, "expect": expect})
    return rows


# 分层用例：「指认」（问的是人是谁）和「真假」（问的是汤面那句话成不成立）在中文里
# 长得几乎一样 —— 《怀孕》的「怀孕的是爱人吗」和「爱人怀孕了吗」一字之差，期望的印面
# 正好相反（前者指认那个肚子大的人，落「是」；后者问有没有这回事，落「不是」）。
# 这是判题说明里 `identity` 那段最容易被改坏的地方，所以专门钉一组。
LAYER_CASES = [
    ("pregnancy", "指认 vs 真假", [
        ("怀孕的是爱人吗", ("是",)),
        ("ta 是怀孕的那个吗", ("是",)),
        ("肚子大的那个是爱人吗", ("是",)),
        ("爱人怀孕了吗", ("不是",)),
        ("肚子里是胎儿吗", ("不是",)),
        ("爱人肚子里是蛔虫吗", ("是",)),
    ]),
    ("jumper", "指认 vs 真假", [
        ("打电话的是活人吗", ("是",)),
        ("她是自杀的吗", ("是",)),
    ]),
    ("rental", "指认 vs 真假", [
        ("老鼠爬的声音是房东弄出来的吗", ("是",)),
        ("那声音是老鼠吗", ("不是",)),
    ]),
    ("siblings", "指认 vs 真假", [
        ("直播的是妹妹本人吗", ("不是",)),
    ]),
    ("mermaid", "指认 vs 真假", [
        ("粉色的水蛇是蛇吗", ("不是",)),
        ("美人鱼是条真的鱼吗", ("不是",)),
    ]),
]


def plan(srv, ids: list[str], quick: bool) -> list[tuple[str, dict, bool, tuple[str, ...]]]:
    """产出 (卷, cast条目, 问男?, 期望标签)。写定 → 两个方向都问；未写明 → 两个方向都问。"""
    out = []
    for pid in ids:
        p = srv.PUZZLES[pid]
        rows = p.get("cast") or []
        if quick:
            rows = [r for r in rows if r["sex"] in ("男", "女")][:1]
        for r in rows:
            if r["sex"] == "男":
                out.append((pid, r, True, CORE))
                out.append((pid, r, False, CORE_INV))
            elif r["sex"] == "女":
                out.append((pid, r, False, CORE))
                out.append((pid, r, True, CORE_INV))
            elif r["sex"] == "未写明":
                out.append((pid, r, True, SOFT))
                out.append((pid, r, False, SOFT))
            # 跨阶段（双性人 / 换身体 / 女与小孩）不机械断言：交给人工复看
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--order", choices=("last", "mid"), default="last",
                    help="cast 在 state 里的位置：last=末尾（线上口径），mid=facts 后面")
    ap.add_argument("--quick", action="store_true", help="每卷只挑一条写定的人")
    ap.add_argument("--no-cast", action="store_true",
                    help="把 cast 从 state 里去掉（量「只有说明、没有人物表」的旧行为）")
    ap.add_argument("--ids", nargs="*", default=[], help="只测这几卷")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--repeat", type=int, default=1, help="每条问几次（抖动才看得出来）")
    ap.add_argument("--out", default=str(ROOT / "tmp" / "_castcheck.txt"))
    args = ap.parse_args()

    srv = load_server(args.order, args.no_cast)
    parity = check_parity(srv)
    if parity:
        print("两条链路口径不一致，先修这个（下面不联网跑）:")
        for e in parity:
            print("  ✗ " + e)
        return 1
    print("双链路口径一致（说明正文 + state 字段顺序）")
    ids = args.ids or [p["id"] for p in srv.BUNDLE["puzzles"]]
    todo = plan(srv, ids, args.quick)

    lock = threading.Lock()
    results: list[dict] = []

    def run(item):
        pid, entry, ask_male, expect = item
        for r in probe_one(srv, pid, entry, ask_male, args.repeat):
            r["expect"] = expect
            with lock:
                results.append(r)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(run, todo))

    # 跨阶段条目：手写用例，--quick 也照跑（只有 3 卷、6 问）
    special_ids = set(ids)
    for pid, note, cases in SPECIAL_CASES:
        if pid not in special_ids:
            continue
        for row in probe_special(srv, pid, note, cases, args.repeat):
            with lock:
                results.append(row)

    # 指认 / 真假分层用例：同上，按卷过滤
    for pid, note, cases in LAYER_CASES:
        if pid not in special_ids:
            continue
        for row in probe_special(srv, pid, note, cases, args.repeat):
            with lock:
                results.append(row)

    # 汇总：按卷打印，每行一条问法
    lines = [f"=== 身份题回归（order={args.order} repeat={args.repeat} 问数={len(todo) * args.repeat}）===", ""]
    bad, amb, err = [], [], []
    for r in sorted(results, key=lambda x: (x["pid"], x["entry"], x["q"])):
        expect = r["expect"]
        kind = verdict_of(r, expect)
        mark = {"ok": "✓", "ambiguous": "~", "bad": "✗", "error": "!!"}[kind]
        probs = r["probs"]
        top = " ".join(f"{k}={probs[k]:.2f}" for k in
                       sorted(probs, key=lambda k: -probs[k])[:3]) if probs else r["note"]
        lines.append(f"  {mark} {r['pid']:<14} {r['entry']:<16} cast={r['sex']:<5} "
                     f"《{r['q']}》 → {r['label']:<5} 期望{'/'.join(expect)}   {top}")
        if kind == "bad":
            bad.append(r)
        elif kind == "ambiguous":
            amb.append(r)
        elif kind == "error":
            err.append(r)

    report = "\n".join(lines)
    print(report)
    print()
    total = len(results)
    print(f"共问 {total}：对 {total - len(bad) - len(amb) - len(err)}，"
          f"两可 {len(amb)}，错 {len(bad)}，失败 {len(err)}")
    if amb:
        print("\n两可档（算过，但要复看问法）:")
        for r in amb[:20]:
            print(f"   {r['pid']} 《{r['q']}》 → {r['label']}")
    if bad:
        print("\n落错档（必须修）:")
        for r in bad[:40]:
            print(f"   {r['pid']} {r['entry']}={r['sex']} 《{r['q']}》 → {r['label']}"
                  f"   期望{'/'.join(r['expect'])}")
    if err:
        print("\n调用失败:")
        for r in err[:20]:
            print(f"   {r['pid']} 《{r['q']}》 {r['note']}")
    Path(args.out).write_text(report + f"\n\n错 {len(bad)} / 两可 {len(amb)} / 失败 {len(err)}\n",
                              encoding="utf-8")
    print(f"\n明细已写 {args.out}")
    return 1 if (bad or err) else 0


if __name__ == "__main__":
    sys.exit(main())
