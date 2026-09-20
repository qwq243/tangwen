#!/usr/bin/env python3
"""给每一卷判一个汤色，写进 puzzles.json 的 soup 字段。

**口径的来源**：知乎《海龟汤：一场脑洞大开的推理游戏之旅》第四节的
「海龟汤常见分类」（https://zhuanlan.zhihu.com/p/2032042332867007256 ）：

    清汤：无恐怖、无死亡，轻松脑洞。
    红汤：有尸体、命案，偏悬疑。
    黑汤：重口味、血腥、惊悚，慎玩。

落到这套 44 卷上，三档按「汤底要玩家咽下的是什么」切：

    清汤  汤底里没有人死 —— 轻松的脑洞、典故
    红汤  有人死（尸体 / 命案 / 亡者 / 灵异），但死法本身不是卖点
    黑汤  重口本身就是卖点 —— 对尸体或身体的处置（分尸、剥皮、食、寄生、
          拼接、活埋、换脑……），无论出没出尸体

**这跟 difficulty 是两个正交的轴**：difficulty 量「要问出几件事」（难度），
soup 量「要咽下什么」（口味）。浅卷可以是黑汤，深卷可以是红汤 —— 挑卷的
时候这两件事都要知道，所以分开两个字段。

**为什么这里的提议是「提议」不是「公式」**：难度那一套（关键点数 / 隐喻层数 /
事实条数）全是现成的数，一算就准。汤色是语义判断：「有没有人死」能从汤底扫出来，
「这个死法算不算重口」得读一遍。所以本脚本给的是关键词提议 + 命中证据，
**值以 puzzles.json 里的字为准** —— 跟 difficulty.py 一个规矩：已有的值不会被
覆盖（除非 --force），觉得哪一卷判错了直接改那两个字。

关键词表是照着最初的 34 卷量出来的，新卷提示只是起手式：**看证据列，别看提议列**。
命中「重口的处置」那几个词才是要人复看的地方。
补进 10 卷后又验了一次这套词表：命中两处误判 —— 《蚊子》只因为「血」被提议成黑汤
（死的是蚊子、血是吸来的，实际该是清汤），《日记》的「贴狗皮 / 尸体做狗粮」没被认出来
（实际是黑汤）。两处都在 puzzles.json 里人工定了，脚本照规矩把它们列进「不一致」等人复看。
**别为了消掉这两条去扩词表** —— 「血」「死」在别的卷里是有效信号，收紧一点就会误伤。

用法：
    python tools/soup.py             # 打印每卷汤色 + 命中证据 + 与提议不一致的卷
    python tools/soup.py --write     # 把缺 soup 的卷按提议填上，并同步 functions/puzzles.json
    python tools/soup.py --write --force   # 全部按提议重算（会盖掉手改过的）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUZZLES = ROOT / "puzzles.json"
FUNCTIONS = ROOT / "functions" / "puzzles.json"

ORDER = ("清汤", "红汤", "黑汤")
LABELS = {
    "清汤": "无死亡，轻松脑洞",
    "红汤": "有人死，偏悬疑但不见血",
    "黑汤": "重口本身就是卖点 · 慎玩",
}

# 「有人死」：命中即至少红汤。
# 注意这几个词在绝大多数卷里都会命中 —— 海龟汤本来就卷卷有人死，所以它只用来
# 把「清汤 / 非清汤」分开，区分不了红与黑。（清汤那几卷靠的是人工判断，
# 例《蚊子》：词表命中了「死」，死的是蚊子不是人。）
DEATH_WORDS = (
    "死", "尸", "命案", "凶", "杀", "自刎", "自杀", "遇难", "殉", "葬",
    "遗体", "头颅", "屠", "惨案", "谋杀", "毒", "塌方", "爆炸", "淹", "溺",
    "亡", "解剖", "刑", "鬼", "去世", "丧", "复活", "骨灰",
)

# 「重口的处置」：命中即黑汤。
# 断的不是「有没有尸体」（尸体几乎卷卷都有），而是**对尸体 / 身体做了什么**：
# 分尸、剥皮、食、寄生、拼接、活埋。这几个词才是红汤与黑汤真正的分界。
GORE_WORDS = (
    "人彘", "切去", "切下", "割", "肢解", "分尸", "剥", "掏空", "肠", "内脏",
    "尸蜡", "尸水", "食人", "吃人", "吃我", "吃尸", "吃掉", "充饥", "蛔虫",
    "寄生", "虫", "拼接", "缝", "换脑", "冥婚", "活埋", "封进", "奸",
    "恋尸", "猥亵", "性侵", "人皮", "搅碎", "血", "雪人", "罐头", "畸形",
    "胳膊",
)


def blob_of(p: dict) -> str:
    """这一卷「玩家最终要知道的东西」拼成一段 —— 汤底 + 隐喻 + facts 的键名。
    不看汤面（汤面是刻意藏起来的，藏得越干净越不该被算作重口）。"""
    return " ".join([
        p.get("bottom") or "",
        " ".join(p.get("metaphor_map") or []),
        " ".join((p.get("facts") or {}).keys()),
    ])


def hits(text: str, words) -> list[str]:
    return [w for w in words if w in text]


def propose(p: dict) -> tuple[str, list[str], list[str]]:
    """按关键词提议一个汤色，返回 (汤色, 重口命中, 死亡命中)。"""
    text = blob_of(p)
    gore = hits(text, GORE_WORDS)
    death = hits(text, DEATH_WORDS)
    if gore:
        return "黑汤", gore, death
    if death:
        return "红汤", gore, death
    return "清汤", gore, death


def main() -> int:
    write = "--write" in sys.argv
    force = "--force" in sys.argv
    bundle = json.loads(PUZZLES.read_text(encoding="utf-8"))

    rows, mismatch, missing = [], [], []
    for i, p in enumerate(bundle["puzzles"], 1):
        want, gore, death = propose(p)
        now = p.get("soup", "")
        rows.append((i, p["id"], p["title"], now, want, gore, death,
                     p.get("difficulty", "")))
        if not now:
            missing.append(p["id"])
        elif now != want:
            mismatch.append((p["id"], now, want, gore))

    print(f"{'卷':>2}  {'id':<14}{'汤色':<4}{'难度':<4} 重口证据 / 死亡信号")
    for no, pid, title, now, want, gore, death, diff in rows:
        flag = "" if now == want else ("（缺）" if not now else "（与提议不一致）")
        ev = ("重口=" + "、".join(gore[:5])) if gore else ("死亡=" + "、".join(death[:5]))
        print(f"{no:>2}  {pid:<14}{now or want:<4}{diff:<4} {ev}{flag}   {title}")

    counts = {}
    for _, _, _, now, want, _, _, _ in rows:
        counts[now or want] = counts.get(now or want, 0) + 1
    print("\n眼下：" + "  ".join(f"{k} {counts.get(k, 0)} 卷" for k in ORDER))
    for k in ORDER:
        print(f"  {k}：{LABELS[k]}")

    if missing:
        print(f"\n缺 soup 的卷（{len(missing)}）：" + "、".join(missing))
    if mismatch:
        print(f"\n与关键词提议不一致（{len(mismatch)}）—— 各复看一遍，"
              "是关键词太粗还是标签写错了：")
        for pid, now, want, gore in mismatch:
            print(f"  {pid}: 文件里是 {now}，关键词提议 {want}"
                  + (f"（命中 {'、'.join(gore[:4])}）" if gore else ""))

    if not write:
        print("\n（只打印。要写回加 --write；只填缺的，不动已有的）")
        return 0

    changed = 0
    for p in bundle["puzzles"]:
        want, _, _ = propose(p)
        if force or not p.get("soup"):
            if p.get("soup") != want:
                p["soup"] = want
                changed += 1
    text = json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
    PUZZLES.write_text(text, encoding="utf-8")
    FUNCTIONS.write_text(text, encoding="utf-8")     # 部署前必须与根目录逐字节一致
    print(f"\n写了 {changed} 卷的 soup；puzzles.json 与 functions/puzzles.json 已同步")
    return 0


if __name__ == "__main__":
    sys.exit(main())
