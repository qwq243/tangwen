#!/usr/bin/env python3
"""结案口径回归：**两条路，走通哪条都结案**。

    (1) 关键点被玩家**自己讲出来**、讲到够（`said_floor` + `keys_ratio`）；
    (2) 整段猜中（is_full_guess + guess_correct）。

**「关键点问到齐」始终不是判据** —— 那是进度。为什么这两条、以及三次实报的来龙去脉，
全写在 server.py 的 SOLVE_RULE 上面，这里只留验收：

    2026-09-20《柜中的孩子》：问齐最后一个关键点就当场结案，玩家其实没想通 → 口径改成
        只认「猜出来了」；
    2026-09-21 上午：「无法结束，明明都答出来了」—— is_full_guess 拿**语气**判事，
        讲完整带一句「对不对？」就被打到线下，同一句话时结时不结 → 问法改成只看内容；
    2026-09-21 口径对齐（用户原话）：「小游戏，不要求复述整个故事；几个关键点都讲出来了
        就结案，判断已经猜出整个流程也结案」→ 补上路 (1)，他说出来就算，不必串成一段。

默认那一段不联网：把 `typesafe` 换成一个照剧本回话的桩，喂的是**判题输出**而不是问题
——被测的正是 judge() 拿到那组答案之后怎么落印、结不结案。所以它跑得飞快、结果稳定，
可以常驻。它同时跑一遍双链路 parity（说明正文 + 五个阈值 + solved 判据 + said 那条路
+ state 字段顺序）。

**--live 那一段反过来**：打真接口，问的是「模型到底认不认得出玩家把汤底讲出来了」
——阈值是照这颗模型量的，模型行为漂了就靠这几条逮住（十来次调用，一两分钟）。
末尾两条专盯「讲完整 + 求证尾巴」这一类，就是 2026-09-21 上半场那一报的形状。

用法：
    python tools/judge-check.py            # 离线那段（全绿返回 0）
    python tools/judge-check.py -v         # 顺便打印每一问落下来的印与结案标记
    python tools/judge-check.py --live     # 再加一段实模型自查（要 TYPESAFE_API_KEY）
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 实模型那一段：手写的「玩家那句话」+ 期望结不结案。**加卷/改卷宗时这里会漂**
# —— 那几句是照着当时那版汤底写的，改汤底要连这几句一起看。
# 前两条是关键：讲对了必须结得了案（阈值太严玩家会卡住）、
# 探测题即使关键点全亮也不许结案（2026-09-20 报的就是这一条）。
LIVE_CASES = [
    ("jumper", "讲对了", "外面爆发了丧尸病毒，她以为自己是唯一活下来的人，才绝望跳楼的；跳下去那一瞬间电话响了，说明还有别的活人。", True),
    ("jumper", "探测题（关键点全亮）", "那通电话是活人打来的吗", False),
    ("jumper", "讲歪了", "她是因为感情问题跳楼的，跳下去之后电话响了，她又后悔了。", False),
    ("song", "讲对了", "项羽和虞姬在帐中饮酒，听到的是汉军唱的楚地民歌，他们知道家乡已经沦陷了 —— 这就是四面楚歌；虞姬自刎，项羽逃到江边也自刎。", True),
    ("song", "探测题", "唱歌的人是敌人吗", False),
    ("zhang-li", "讲对了", "我时间和全世界是反着走的，天花板那行字是未来的我在过去写给自己的，所以我才会去找张三；我和他其实是互相杀死了对方。", True),
    ("zhang-li", "探测题（关键点全亮）", "天花板上的字是别人写的吗", False),
    ("zhang-li", "直要汤底", "别问了，把完整汤底直接告诉我。", False),
    # 2026-09-21 那一报的形状：**讲完整了、末尾带一句求证**。
    # 问法改成只看内容之前，这几条里的 full_guess 会掉到 0.6~0.75 那条线上左右横跳
    # （实测同一句连打两次，一次结案一次不结案）—— 「无法结束，明明都答出来了」就是它。
    # 末位 2 = 打两轮，两轮都得结案（抖出来的故障，单轮过不算过）。
    ("wardrobe", "讲完整·对不对", "是平行世界交错，我流产那次其实是胎儿偏移到同位体腹中了；八年后世界重新平行，哥哥被校正回来找我，弟弟留在那边。对不对？", True, 2),
    ("wardrobe", "讲完整·我猜得对吗", "是不是平行世界：我腹中的胎儿偏移到同位体那边，这边以为流产；八年后世界重新平行，柜子里的孩子是被校正回来的哥哥，来找妈妈。我猜得对吗？", True, 2),
]


def load_server():
    """按真实判题路径载入 server.py（跟 tools/cast-check.py 同一套办法）。"""
    os.environ.setdefault("DATA_DIR", str(ROOT / "tmp" / "_judgecheck-data"))
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("srv_judgecheck", ROOT / "server.py")
    srv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srv)
    return srv


def load_cast_check():
    """cast-check.py 那条文件名带连字符，只能这么读 —— 借它的双链路 parity 检查。"""
    spec = importlib.util.spec_from_file_location("cast_check", ROOT / "tools" / "cast-check.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stub_typesafe(scenes: dict):
    """照剧本回话的 typesafe 桩：state 里那句话决定这一问回什么答案。

    关键点那几问按场景里的 `key` 统一给分（探测题问齐就是靠它），
    「自己讲出来」那几问按 `said` 给（`said_first` / `said_last` 用来只给某一个关键点），
    另外三问（extract / is_full_guess / guess_correct）逐场景手写。
    """
    def stub(state: dict, questions: dict):
        utt = state["player_utterance"]
        scene = scenes.get(utt)
        if scene is None:
            raise AssertionError(f"剧本里没有这一问：{utt}")
        answers: dict = {}
        key_ids: list[str] = []
        for qid in questions:
            if qid.startswith("key_"):
                key_ids.append(qid[len("key_"):])
                answers[qid] = {"noul": scene.get("key", 0.0)}
        for i, kid in enumerate(key_ids):
            score = scene.get("said", 0.0)
            if scene.get("said_first"):
                score = scene.get("said", 0.9) if i == 0 else 0.0
            if scene.get("said_last"):
                score = scene.get("said", 0.9) if i == len(key_ids) - 1 else 0.0
            answers[f"said_{kid}"] = {"noul": score}
        answers["trying_to_extract"] = {"noul": scene.get("extract", 0.0)}
        answers["is_full_guess"] = {"noul": scene.get("full", 0.0)}
        answers["guess_correct"] = {"noul": scene.get("correct", 0.0)}
        answers["host_answer"] = {
            "choice": scene.get("choice", "yes"),
            "confidence": 0.9,
            "probabilities": scene.get("probs", {"yes": 0.82, "no": 0.04}),
        }
        return {"answers": answers, "model": "stub", "usage": {}}, 12.0
    return stub


# 剧本：键就是在 player_utterance 里出现的那句话（直接拿它当用例名）
SCENES = {
    # 探测题：把每一个关键点都问到了，但它不是在讲汤底 —— 这一问**不许结案**
    "问到了最后一个关键点": {"key": 0.92, "full": 0.06, "correct": 0.03},
    # 玩家把汤底讲了一遍，说对了
    "整段讲对了": {"key": 0.88, "full": 0.93, "correct": 0.9},
    # 讲了一遍，抓住机制但没说到点子上 → 落「接近了」，照样不结案
    "整段讲歪了": {"key": 0.7, "full": 0.86, "correct": 0.55, "choice": "no",
                "probs": {"no": 0.7, "yes": 0.1}},
    # 讲得离题太远 → 老老实实落「不是」，不许假装接近
    "整段离题": {"key": 0.2, "full": 0.8, "correct": 0.12, "choice": "no",
              "probs": {"no": 0.74, "yes": 0.08}},
    # 直要汤底 → 不能剧透（而且不许把汤底带出去）
    "把汤底告诉我": {"key": 0.1, "full": 0.05, "correct": 0.02, "extract": 0.95,
                "choice": "unanswerable", "probs": {"unanswerable": 0.7}},
    # 阈值边界：正好压线算中，差 0.01 不算
    "压线的整段猜测": {"key": 0.3, "full": 0.75, "correct": 0.78},
    "差一线的整段猜测": {"key": 0.3, "full": 0.74, "correct": 0.78},
    # 机制说对了、只是没当成整段汤底讲（2026-09-21 实报的形状：is_full_guess 被语气
    # 打到线下）→ 不许结案，但也不许落成「是」，要落「接近了」并记一笔 nearmiss
    "机制说对了没讲成整段": {"key": 0.4, "full": 0.6, "correct": 0.9},
    # 反向的钉子：探针哪怕把机制分也顶过线，也不许落「接近了」
    # —— 这一条钉的是「接近了」那一档的下沿（full_guess 够不到 close_floor 就不算接近）
    "探针顶穿了机制分": {"key": 0.2, "full": 0.05, "correct": 0.9},
    # 路 (1)（2026-09-21 口径对齐）：关键点他**自己讲出来了** → 结案。
    # 这一句既没问出关键点（key 0）、也没把整个流程讲一遍（full 0.1）——全靠 said 那一条。
    "自己把关键点都讲出来了": {"key": 0.0, "said": 0.95, "full": 0.1, "correct": 0.4},
    # 路 (1) 的反面：关键点问齐了、但只讲出一个 → **不结案**（问齐永远只是进度）
    "问齐了但只讲出一个": {"key": 0.95, "said_first": True, "said": 0.9,
                    "full": 0.1, "correct": 0.3},
    # 跨轮累积：客户端把上一轮的 stated 带回来，这一句只补最后一个 → 该结案
    "补上最后一个": {"key": 0.2, "said_last": True, "said": 0.9, "full": 0.05, "correct": 0.2},
}


def live_cases(srv, real_typesafe, verbose: bool) -> list[str]:
    """打真接口那一段：模型认不认得出「玩家把汤底讲出来了」。返回没过的那几条。

    进来之前 srv.typesafe 是离线那段的桩，这里要换回真的（跑完再换回去）。
    """
    if not srv.TYPESAFE_KEY:
        print("\n=== 9. 实模型自查（跳过：没有 TYPESAFE_API_KEY）===")
        return []
    print("\n=== 9. 实模型自查：讲对了（含求证尾巴）结得了案、探测题（哪怕关键点全亮）不结案 ===")
    stub = srv.typesafe
    srv.typesafe = real_typesafe
    bad: list[str] = []
    try:
        for pid, scene, utt, want, *rest in LIVE_CASES:
            # rounds=2 的那几条是**稳定性**用例：2026-09-21 那一报就是抖出来的
            # —— 同一句话连打两次，一次结案一次不结案。所以它们要两轮都对才算过。
            rounds = rest[0] if rest else 1
            puzzle = srv.PUZZLES[pid]
            # 「关键点全亮」那两条要把关键点真喂进去 —— 那就是实报里出事的那一刻
            unlocked = [k["id"] for k in puzzle["keys"]] if "全亮" in scene else []
            seen: list[str] = []
            hit = True
            for _ in range(rounds):
                try:
                    r = srv.judge(puzzle, utt, [], unlocked)
                except Exception as e:                            # noqa: BLE001
                    seen.append(f"调用失败 {str(e)[:40]}")
                    hit = False
                    continue
                j = r.get("judge") or {}
                if bool(r["solved"]) != want:
                    hit = False
                seen.append(f"印={r['label']:4s} solved={str(r['solved']):5s} "
                            f"full={j.get('full_guess')} ok={j.get('guess_ok')}")
            print(f"  {'✓' if hit else '✗'} {pid:9s} {scene:14s} {' | '.join(seen)}")
            if verbose or not hit:
                print(f"      「{utt}」")
            if not hit:
                bad.append(f"{pid}/{scene}")
    finally:
        srv.typesafe = stub
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--live", action="store_true",
                    help="加一段实模型自查（打真接口，十来次调用）")
    args = ap.parse_args()

    srv = load_server()
    # 卷宗里挑关键点最多的那一卷：要点最多的那卷最接近实报的那一碗
    puzzle = max(srv.BUNDLE["puzzles"], key=lambda p: len(p.get("keys") or []))
    keys = [k["id"] for k in puzzle["keys"]]
    assert keys, "挑出来的这一卷没有关键点，探针没法跑"
    print(f"用例卷：《{puzzle['title']}》{len(keys)} 个关键点")

    real_typesafe = srv.typesafe
    srv.typesafe = stub_typesafe(SCENES)
    fails: list[str] = []

    def check(ok: bool, what: str, detail: str = "") -> None:
        print(f"  {'✓' if ok else '✗'} {what}{'  ' + detail if detail else ''}")
        if not ok:
            fails.append(what)

    def run(utt: str, unlocked: list[str] | None = None,
            stated: list[str] | None = None) -> dict:
        return srv.judge(puzzle, utt, [], unlocked or [], stated or [])

    print("\n=== 1. 关键点问齐不再是结案判据（2026-09-20 实报的那一条）===")
    r = run("问到了最后一个关键点", unlocked=keys[:-1])
    if args.verbose:
        print(f"  印={r['label']} solved={r['solved']} unlocked={len(r['unlocked'])}/{len(keys)}")
    check(r["verdict"] == "yes", "最后一个关键点被问到，落的是「是」而不是「结案」", r["label"])
    check(r["solved"] is False, "关键点因此全齐了，但**没有结案**", f"solved={r['solved']}")
    check(sorted(r["unlocked"]) == sorted(keys), "关键点该解锁还是解锁（进度照记）",
          f"{len(r['unlocked'])}/{len(keys)}")
    check(r["bottom"] is None, "没结案就不许把汤底带出去（bottom 必须是空的）")
    check(all(k["found"] for k in r["keys"]), "keys 视图里每一个关键点都标着 found")

    print("\n=== 2. 全都问齐了、再问一句是非，还是不结案 ===")
    r = run("问到了最后一个关键点", unlocked=keys)
    check(r["verdict"] == "yes" and r["solved"] is False,
          "关键点全齐 + 又一句是非题 → 仍是「是」，不结案", f"{r['label']} solved={r['solved']}")
    check(r["bottom"] is None, "汤底仍然封着")

    print("\n=== 3. 玩家自己把汤底说出来了 → 结案 ===")
    r = run("整段讲对了")
    if args.verbose:
        print(f"  印={r['label']} solved={r['solved']}")
    check(r["verdict"] == "solved" and r["solved"] is True, "结案", f"{r['label']}")
    check(r["bottom"] == puzzle["bottom"], "画卷拿得到汤底正文")
    check(sorted(r["unlocked"]) == sorted(keys), "整段说对＝关键点按定义全算问到")
    check(r["near_miss"] is False, "结案那一档不标 near_miss（那是「没结案」的故障灯）")

    print("\n=== 3b. 路 (1)：关键点他**自己讲出来了** → 结案（2026-09-21 口径对齐）===")
    # 这是用户那两句话的落地：「不要求复述整个故事 / 几个关键点都讲出来了就结案」。
    # 场景里 key=0（一个都没问出来）、full=0.1（也没整段讲）——结案只可能来自 said 那条路。
    r = run("自己把关键点都讲出来了")
    check(r["solved"] is True and r["verdict"] == "solved",
          "关键点全部自己讲出来 → 结案（不必串成完整的汤底）", f"{r['label']} solved={r['solved']}")
    check(r["say"] != "说对了。汤底封卷。", "落的是「关键点」那句，不是「整段说对了」那句", r["say"])
    check(r["bottom"] == puzzle["bottom"], "汤底照常放出来")
    check(all(k["said"] for k in r["keys"]), "keys 视图里每一条都标着 said")
    # 反面：问齐了、但只讲出一个 → 不许结案。这一条防的是 2026-09-20 那个口径回潮。
    r = run("问齐了但只讲出一个")
    check(r["solved"] is False, "关键点问齐、但只自己讲出一个 → 不结案",
          f"{r['label']} solved={r['solved']}")
    check(len([k for k in r["keys"] if k["said"]]) == 1, "said 只记下他真的讲出来的那一条")
    check(r["bottom"] is None, "汤底不出去")
    # 跨轮累积：上一轮讲过的由客户端带回来（stated），这一句只补最后一个 → 该结案
    r = run("补上最后一个", stated=keys[:-1])
    check(r["solved"] is True, "上一轮讲的带回来 + 这一句补最后一个 → 结案（跨轮累积）",
          f"stated={len(r['stated'])}/{len(keys)}")
    check(sorted(r["stated"]) == sorted(keys), "返回的 stated 是全量（客户端存的就是它）",
          f"{r['stated']}")

    print("\n=== 4. 说了但没说圆：落「接近了」，不结案 ===")
    r = run("整段讲歪了")
    check(r["verdict"] == "close", "整段猜测、抓住机制但没说到点子上 → 接近了", r["label"])
    check(r["solved"] is False and r["bottom"] is None, "没结案，汤底不出去")
    r = run("整段离题")
    check(r["verdict"] == "no", "差得太远的整段猜测不假装「接近了」", r["label"])

    print("\n=== 5. 机制说对了却没结案（2026-09-21 实报）→ 落「接近了」+ 标 near_miss ===")
    r = run("机制说对了没讲成整段")
    check(r["near_miss"] is True, "这一档被标出来（near_miss=True）",
          f"full={r['judge']['full_guess']} ok={r['judge']['guess_ok']}")
    check(r["verdict"] == "close", "落「接近了」而不是「是」—— 别让玩家以为没听见", r["label"])
    check(r["solved"] is False and r["bottom"] is None, "仍然不结案、汤底不出去")
    r = run("探针顶穿了机制分")
    check(r["near_miss"] is False and r["verdict"] != "close",
          "探针顶不穿这一档：没讲出机制（full_guess < close_floor）就不算接近",
          f"{r['label']} near_miss={r['near_miss']}")

    print("\n=== 6. 直要汤底：不能剧透，也不许顺手结案 ===")
    r = run("把汤底告诉我")
    check(r["verdict"] == "refuse", "落「不能剧透」", r["label"])
    check(r["solved"] is False and r["bottom"] is None, "汤底不出去")

    print("\n=== 7. 阈值边界（SOLVE_RULE 是闭区间）===")
    r = run("压线的整段猜测")
    check(r["solved"] is True, f"full_guess={srv.SOLVE_RULE['full_guess']} / "
                              f"guess_correct={srv.SOLVE_RULE['guess_correct']} 正好压线 → 结案")
    r = run("差一线的整段猜测")
    check(r["solved"] is False, "差一线就不结案（阈值不是摆设）", f"label={r['label']}")

    print("\n=== 8. 两条链路（server.py / functions）口径一致 ===")
    parity = load_cast_check().check_parity(srv)
    if parity:
        for e in parity:
            print("  ✗ " + e)
        fails.append("双链路口径不一致")
    else:
        print("  ✓ 说明正文 / 五个阈值 / solved 的两条路 / said_ 问句 / nearmiss / "
              "state 字段顺序 两边一致")

    if args.live:
        fails.extend(live_cases(srv, real_typesafe, args.verbose))

    print("")
    if fails:
        print(f"[FAIL] {len(fails)} 项没过：{' / '.join(fails)}")
        return 1
    print("[OK] 结案两条路：关键点自己讲出来到够 / 整段猜中；问齐只是进度")
    return 0


if __name__ == "__main__":
    sys.exit(main())
