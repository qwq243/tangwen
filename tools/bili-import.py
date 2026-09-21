#!/usr/bin/env python3
"""从 B 站专栏合集把海龟汤抓下来，拆成一条条，再跟已有卷宗去重。

**这批卷宗的作者是抖音的「许二木」**。抓的是「许二木海龟汤文字版」合集
（在 B 站，`rl999117`，一周三更）—— 那是文字版的入口，不是原始出处。
现有的 44 卷全部来自这个合集 —— 加新卷就是从它继续往回捞。

三步，`--step` 分开跑也行，默认一次跑完：

    fetch    抓合集文章列表 + 每篇正文 → tmp/_bili_raw/
    parse    按「汤面 / 汤底」锚点拆条      → tmp/_bili_parsed.json
    dedupe   跟 puzzles.json 比标题 + 汤面 → tmp/_bili_dedupe.json

**为什么不能直接打 `x/article/view`**：那个接口对这批稿子一律回 -352（风控），
专栏页面本身又是 SPA 空壳（HTML 只有 3KB 外壳，正文全靠 JS 渲染）。
唯一拿得到正文的是**动态 opus 详情接口**，用列表接口给的 `dyn_id_str` 当 opus id。

**去重为什么两条判据都要**：只看标题会漏（《新房》入库时改叫《出租房》），
只看汤面也会漏（同一碗汤可以重写）。标题归一化相同或互相包含算命中，
汤面 difflib 相似度 ≥ 0.62 也算命中，两条命中其一即判为已有。

**入库不是照搬原文。** 这个脚本只负责把「哪些是新的」挑出来；
新卷的 `facts` / `keys` / `metaphor_map` 是逐卷读一遍手工写的（判题的准头全在这上面），
所以不放进这个脚本 —— 见 README「语料来源与补卷」。

用法：
    python tools/bili-import.py                     # 三步全跑，只对已有的 raw 增量抓
    python tools/bili-import.py --step dedupe       # 只重跑去重
    python tools/bili-import.py --list 999117       # 换成别的合集 id

    # 抓完之后的上线顺序（都在这套脚本之外）：
    #   1. 手工把新卷写进 puzzles.json（facts / keys / metaphor_map）
    #   2. python tools/difficulty.py --write && python tools/soup.py --write
    #   3. 在 tools/cast.py 的 CAST 里补这一卷的人物表 —— 性别只认材料写明的
    #      （汤底有性别名词、或干净的他 / 她才写男 / 女，其余写「未写明」），
    #      再 python tools/cast.py --write
    #   4. 写提示词 -> python generate_covers.py <name.png> -> python make_webp.py <name.png>
    #   5. 打真接口确认判得动 —— 这一条别省，schema 全对跟「判得动」是两回事
    #      （页面上问几句即可；阈值那一层用 python tools/judge-check.py --live）
    #      python tools/cast-check.py --ids <id>    # 身份题也过一遍
    #   6. python tools/suite.py                    # 全套界面自查
    #   7. 同步 functions/puzzles.json 后部署（tools/cast.py --write 顺手就同步了）
"""
from __future__ import annotations

import difflib
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "tmp"
RAW = TMP / "_bili_raw"
PUZZLES = ROOT / "puzzles.json"

DEFAULT_LIST = 999117
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
# opus 详情接口不给不带 buvid 的请求（回 -352），这只 cookie 是匿名指纹，不是账号凭据
COOKIE = "buvid3=5EA48FEB-F1EE-A526-6483-BB19132CDF9394318infoc"

# 汤面相似度到多少就算同一碗
SAME = 0.62

# ── 标题行 ───────────────────────────────────────────────────────────────
M_SURF = re.compile(r"^\s*汤\s*面\s*[:：]?\s*(.*)$")
M_BOT = re.compile(r"^\s*汤\s*底\s*[:：]?\s*(.*)$")
M_TITLE = re.compile(r"^\s*(\d+)\s*[（(]\s*(\d+)\s*[)）]\s*[.．、]?\s*(.*)$")
M_TITLE1 = re.compile(r"^\s*(\d+)\s*[.．、]\s*(.*)$")
M_SEASON = re.compile(r"^\s*S\s*(\d+)\s*赛季\s*$", re.I)
M_NOTE = re.compile(r"^\s*[（(]\s*.*赛季结束\s*[)）]\s*$", re.I)
M_ANNO = re.compile(r"[（(][^）)]*[）)]")
M_BOOK = re.compile(r"《([^》]+)》")
BARE_ANNO = ("本格", "变格", "王八汤", "黑汤", "红汤", "清汤", "个人赛")

# 整篇没有标题行的稿子，标题只能人工指定
ARTICLE_TITLE = {"cv51443133": ["熵增", "老农"]}


def get(url: str) -> dict:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
        "Cookie": COOKIE,
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


# ══ 1. fetch ════════════════════════════════════════════════════════════
def para_text(para: dict) -> str:
    """一个段落拼成一行。列表 / 引用 / 代码都收干净，只留字。"""
    chunks: list[str] = []
    for node in (para.get("text") or {}).get("nodes") or []:
        w = (node.get("word") or {}).get("words")
        if w:
            chunks.append(w)
    for key in ("link_card", "code"):
        blob = para.get(key)
        if isinstance(blob, dict):
            chunks.append(blob.get("text") or blob.get("content") or "")
    return "".join(chunks).replace("\u200b", "").strip()


def fetch(list_id: int) -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    meta = get(f"https://api.bilibili.com/x/article/list/web/articles"
               f"?id={list_id}&pn=1&ps=50")
    (RAW / "list.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
    lst, arts = meta["data"]["list"], meta["data"]["articles"]
    print(f"合集：{lst['name']}  文章 {lst['articles_count']} 篇  字数 {lst['words']}")

    for a in arts:
        cv = f"cv{a['id']}"
        dest = RAW / f"{cv}.json"
        opus = a.get("dyn_id_str")
        if not opus:
            print("NO_OPUS", cv)
            continue
        if dest.exists() and dest.stat().st_size > 2000:
            print("skip", cv)
        else:
            try:
                d = get("https://api.bilibili.com/x/polymer/web-dynamic/v1/"
                        f"opus/detail?id={opus}")
            except Exception as e:                    # noqa: BLE001
                print("FAIL", cv, e)
                continue
            if d.get("code") != 0:
                print("FAIL", cv, d.get("code"), d.get("message"))
                continue
            dest.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
            time.sleep(1.2)                           # 别把接口打急了

        d = json.loads(dest.read_text(encoding="utf-8"))
        lines: list[str] = []
        for m in d["data"]["item"].get("modules") or []:
            if m.get("module_type") != "MODULE_TYPE_CONTENT":
                continue
            for p in (m.get("module_content") or {}).get("paragraphs") or []:
                t = para_text(p)
                if t:
                    lines.append(t)
        (RAW / f"{cv}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"OK {cv}  段 {len(lines)}  字 {sum(len(x) for x in lines)}")
    return 0


# ══ 2. parse ════════════════════════════════════════════════════════════
def clean_title(s: str) -> str:
    s = s.strip()
    m = M_BOOK.search(s)
    if m:
        return m.group(1).strip()
    s = re.sub(r"^《\s*|\s*》$", "", s)
    s = M_TITLE.sub(r"\3", s)          # 削掉条目号 `14（37）` / `1（24）.`
    s = M_TITLE1.sub(r"\2", s)
    s = re.split(r"限\s*时", s)[0]
    s = M_ANNO.sub("", s)
    for _ in range(4):                 # 裸标注（`张三李四 变格 限时30次`）
        t = s.strip(" 　·.、,，-—")
        for w in BARE_ANNO:
            if t.endswith(w):
                t = t[: -len(w)]
        if t == s:
            break
        s = t
    return s.strip(" 　·.、,，-—")


def looks_like_title(s: str) -> bool:
    """真标题一定带「本格 / 变格 / 王八汤 / 限时 / 个人赛」这类标注，或带书名号。

    这一条是为了把正文里的「1.这根用来驱邪的蜡烛，你千万不要吹灭…」之类排掉 ——
    它也是「数字. 后面跟字」，光看数字前缀会把《吹蜡烛》的规则拆成好几条。
    """
    t = s.strip().rstrip("。.．，,、;；:：")
    if not t or len(t) > 44 or t.startswith("汤"):
        return False
    anno = any(k in t for k in ("本格", "变格", "王八汤", "限时", "赛季", "个人赛"))
    numbered = bool(M_TITLE.match(t) or M_TITLE1.match(t))
    if numbered and anno:
        return True
    return "《" in t and (anno or len(t) <= 20)


def parse_file(path: Path, art_title: str) -> list[dict]:
    """按「汤面 / 汤底」两个锚点切。标题行随时可能冒出来（上一条的汤底讲完之后），
    所以**遇到像标题的行就先收掉上一条**，再挂着当 pending，等下一个「汤面：」认领。"""
    out: list[dict] = []
    season = pending = None
    cur: dict | None = None
    buf: list[str] = []
    mode: str | None = None

    def flush() -> None:
        nonlocal buf
        if cur is not None and mode:
            text = "\n".join(x for x in buf if x.strip()).strip()
            if text:
                cur[mode] = (cur.get(mode, "") + "\n" + text).strip() if cur.get(mode) else text
        buf = []

    def close() -> None:
        nonlocal cur
        flush()
        if cur and (cur.get("surface") or cur.get("bottom")):
            cur["title"] = clean_title(cur.get("title") or art_title)
            out.append(cur)
        cur = None

    for raw in path.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if not s:
            continue
        m = M_SEASON.match(s)
        if m:
            season = f"S{m.group(1)}"
            continue
        if M_NOTE.match(s):
            continue
        if M_SURF.match(s) is None and M_BOT.match(s) is None and looks_like_title(s):
            close()
            pending = clean_title(s)
            continue
        ms, mb = M_SURF.match(s), M_BOT.match(s)
        if ms:
            title, pending = pending, None
            close()
            cur = {"file": path.stem, "season": season, "title": title or art_title}
            mode = "surface"
            buf = [ms.group(1)] if ms.group(1).strip() else []
            continue
        if mb and cur is not None:
            flush()
            mode = "bottom"
            buf = [mb.group(1)] if mb.group(1).strip() else []
            continue
        if cur is not None:
            buf.append(s)

    close()
    return out


def parse() -> int:
    meta = json.loads((RAW / "list.json").read_text(encoding="utf-8"))
    titles = {f"cv{a['id']}": a["title"] for a in meta["data"]["articles"]}
    allp: list[dict] = []
    for cv, art_title in titles.items():
        f = RAW / f"{cv}.txt"
        if not f.exists():
            continue
        got = parse_file(f, art_title)
        forced = ARTICLE_TITLE.get(cv)
        if forced and len(forced) != len(got):
            print(f"!! {cv} 人工标题 {len(forced)} 个，解析出 {len(got)} 条，对不上")
        for i, g in enumerate(got):
            g["cv"] = cv
            if forced and i < len(forced):
                g["title"] = forced[i]
        allp.extend(got)
        print(f"── {cv}  {art_title}  →  {len(got)} 条")
        for g in got:
            print(f"     [{g.get('season') or '-':>2}] {g['title']:<8} "
                  f"面 {len(g.get('surface') or ''):>3} 字  底 {len(g.get('bottom') or ''):>3} 字")
    (TMP / "_bili_parsed.json").write_text(
        json.dumps(allp, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n合计 {len(allp)} 条 → tmp/_bili_parsed.json")
    return 0


# ══ 3. dedupe ═══════════════════════════════════════════════════════════
def norm(s: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]", "", s or "")


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def dedupe() -> int:
    have = json.loads(PUZZLES.read_text(encoding="utf-8"))["puzzles"]
    incoming = json.loads((TMP / "_bili_parsed.json").read_text(encoding="utf-8"))

    existing, fresh = [], []
    for p in incoming:
        best, best_r, best_t = None, 0.0, 0.0
        for q in have:
            r = ratio(p["surface"], q.get("surface") or "")
            t = 1.0 if norm(p["title"]) == norm(q["title"]) else 0.0
            if t == 0.0:
                a, b = norm(p["title"]), norm(q["title"])
                if a and b and (a in b or b in a):
                    t = 0.9
            if (r, t) > (best_r, best_t):
                best, best_r, best_t = q, r, t
        why = []
        if best_t >= 0.9:
            why.append("标题同")
        if best_r >= SAME:
            why.append(f"汤面 {best_r:.2f}")
        if why:
            existing.append({**p, "dup_of": best["id"], "dup_title": best["title"],
                             "surface_ratio": round(best_r, 3), "why": "、".join(why)})
        else:
            fresh.append({**p, "nearest": best["id"], "nearest_ratio": round(best_r, 3)})

    print(f"合集 {len(incoming)} 条：已有 {len(existing)}，新的 {len(fresh)}\n")
    print("── 已入库（跳过）──")
    for p in existing:
        print(f"  {p['title']:<10} → {p['dup_of']:<14} {p['why']}")
    print(f"\n── 新的 {len(fresh)} 条（要手工补 facts / keys / metaphor_map 再入库）──")
    for p in fresh:
        print(f"  {p['title']:<10} 面 {len(p['surface']):>3} 字  "
              f"(最像 {p['nearest']} {p['nearest_ratio']:.2f})  [{p['cv']}]")

    (TMP / "_bili_dedupe.json").write_text(
        json.dumps({"existing": existing, "new": fresh}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print("\n→ tmp/_bili_dedupe.json")
    if not fresh:
        print("没有新卷，卷宗已经是最新。")
    return 0


def main() -> int:
    args = sys.argv[1:]
    step = "all"
    list_id = DEFAULT_LIST
    if "--step" in args:
        step = args[args.index("--step") + 1]
    if "--list" in args:
        list_id = int(args[args.index("--list") + 1])

    if step in ("all", "fetch"):
        fetch(list_id)
    if step in ("all", "parse"):
        parse()
    if step in ("all", "dedupe"):
        dedupe()
    return 0


if __name__ == "__main__":
    sys.exit(main())
