#!/usr/bin/env python3
"""给每一卷算一个难度标签，写进 puzzles.json 的 difficulty 字段。

**公式（都是汤里现成的客观量，谁都能复算）：**

    score = 关键点数 × 4 + 隐喻层数 × 2 + 事实条数

为什么这么配权重：
  - **关键点数**（`keys`）是这一卷「要问出几件事」—— 海龟汤就难在这里，
    它是最硬的一项，所以 ×4；
  - **隐喻层数**（`metaphor_map` 的条数）是汤面用语翻译成汤底事实要绕几道弯，
    层数越多越容易问偏，×2；
  - **事实条数**（`facts`）是搜索空间的大小，×1。

**分档**（分数严格单调，不会出现「同分不同档」这种说不清的情况）：

    ≤ 31  浅      关键点少，一层隐喻就够
    32~37 中      几个关键点，得绕一两道弯
    ≥ 38  深      关键点多、隐喻成层，慢慢问

这套分数是量出来的，不是拍的：44 卷的取值范围 18~48，两刀切在 31 / 38 上，
三档是 17 / 18 / 9 卷（34 卷时是 24~48、10 / 16 / 8 卷；后来从同一个合集补进 10 卷，
最小值被《蚊子》那碗王八汤拉到 18，两刀的位置不用动）。**标签最终以 puzzles.json
里的字为准** —— 觉得哪一卷不该是这个档，直接改那一个字就行，本脚本不会去覆盖
已经有值的那几卷（要重算全部得显式 `--force`）。

用法：
    python tools/difficulty.py             # 只打印分数表，不写文件
    python tools/difficulty.py --write     # 把缺 difficulty 的填上，并同步 functions/puzzles.json
    python tools/difficulty.py --write --force   # 全部按公式重算（会盖掉手改过的）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUZZLES = ROOT / "puzzles.json"
FUNCTIONS = ROOT / "functions" / "puzzles.json"

CUTS = ((31, "浅"), (37, "中"))          # 超过 37 就是「深」
LABELS = {"浅": "关键点少，一层隐喻就够",
          "中": "几个关键点，得绕一两道弯",
          "深": "关键点多、隐喻成层，慢慢问"}


def score_of(p: dict) -> int:
    return len(p.get("keys") or []) * 4 + len(p.get("metaphor_map") or {}) * 2 + len(p.get("facts") or [])


def label_of(score: int) -> str:
    for limit, name in CUTS:
        if score <= limit:
            return name
    return "深"


def main() -> int:
    write = "--write" in sys.argv
    force = "--force" in sys.argv
    bundle = json.loads(PUZZLES.read_text(encoding="utf-8"))
    rows = []
    for i, p in enumerate(bundle["puzzles"]):
        s = score_of(p)
        want = label_of(s)
        now = p.get("difficulty", "")
        rows.append((s, i + 1, p["id"], p["title"], len(p.get("keys") or []),
                     len(p.get("metaphor_map") or {}), len(p.get("facts") or []), now, want))
    rows.sort()
    print(f"{'分':>3}  {'卷':>2}  {'id':<14}{'keys':>5}{'meta':>5}{'facts':>6}  现在 / 该是   标题")
    for s, no, pid, title, k, m, f, now, want in rows:
        flag = "" if now == want else ("（缺）" if not now else "（不一致）")
        print(f"{s:>3}  {no:>2}  {pid:<14}{k:>5}{m:>5}{f:>6}  {now or '-':<4} / {want} {flag}   {title}")
    counts = {}
    for _, _, _, _, _, _, _, _, want in rows:
        counts[want] = counts.get(want, 0) + 1
    print("\n该是：" + "  ".join(f"{k} {v} 卷" for k, v in sorted(counts.items(), key=lambda kv: "浅中深".index(kv[0]))))
    for k, v in LABELS.items():
        print(f"  {k}：{v}")
    if not write:
        print("\n（只打印。要写回加 --write）")
        return 0
    changed = 0
    for p in bundle["puzzles"]:
        s = score_of(p)
        want = label_of(s)
        if force or not p.get("difficulty"):
            if p.get("difficulty") != want:
                p["difficulty"] = want
                changed += 1
    text = json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
    PUZZLES.write_text(text, encoding="utf-8")
    FUNCTIONS.write_text(text, encoding="utf-8")     # 部署前必须与根目录逐字节一致
    print(f"\n写了 {changed} 卷的 difficulty；puzzles.json 与 functions/puzzles.json 已同步")
    return 0


if __name__ == "__main__":
    sys.exit(main())
