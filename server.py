#!/usr/bin/env python3
"""Turtle soup demo: code hosts, TypeSafe judges. Puzzle bottoms never leave the server until solve/give-up."""

from __future__ import annotations

import base64
import datetime
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
# DATA_DIR 可以指到临时目录，测试就不用往真数据上写（tools/admin-check.py 用）
DATA = Path(os.environ.get("DATA_DIR") or (ROOT / "data"))
PUZZLES_PATH = ROOT / "puzzles.json"
BOARD_PATH = DATA / "board.json"
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
SKILL_ENV = Path.home() / ".codex" / "skills" / "typesafe-ai" / ".env"

# 判题（是 / 不是 / 是也不是 这十档印）固定用 TypeSafe 的 `jev-latest`。
# **不设备胎、不许被环境变量顶掉** —— 十档的准头全靠它：`pick_host` 里那几条阈值
# （0.3 / 0.18 / 0.45 …）都是照着这个模型的概率分布量的，换模型等于换一套判题口径，
# 而且症状是「偶尔判错」这种最难查的。另一条链路（求灯）才是可以退的，见 HINT_MODELS。
TYPESAFE_MODEL = "jev-latest"

HOST_LABELS = {
    "yes": "是",
    "no": "不是",
    "both": "是也不是",
    "partial": "部分对",
    "close": "接近了",
    "irrelevant": "无关",
    "unimportant": "不重要",
    "unanswerable": "问清楚点",
}

# 「问清楚点」是**怪玩家没说清**那一档，不是「这题我答不上来」。但模型读到「材料里
# 没写这件事」时，给的正是 unanswerable 的最高分 —— 实测「跳楼的地点是办公楼吗」：
# unanswerable .51 / unimportant .43，直接落印就成了「问清楚点」，等于让一个问法
# 完全清楚的玩家替模型的为难背锅。所以 pick_host 里模型自己选了 unanswerable 时，
# 还要回头看它有没有把分量压在「不重要 / 无关」上：压住了，说明这一问它听懂了、
# 只是汤底没写，该落软档。两条线都是照 jev-latest 在这类题上的实测分布量的。
SOFT_RESCUE_MIN = 0.30    # 软档（不重要 / 无关）的绝对分量线
SOFT_RESCUE_RATIO = 0.6   # 软档还得追到 unanswerable 的六成，免得乱码顺带的那点分量把它撬走


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(SKILL_ENV)
TYPESAFE_KEY = os.environ.get("TYPESAFE_API_KEY", "")
DATA.mkdir(exist_ok=True)


# ================= 提示模型：Cloudflare Workers AI（免费额度） =================
#
# 2026-09-20 起本地版与线上同源：提示一律走 Workers AI，不再有第二套对话模型。
#   - 线上（functions/api/[[path]].js）走 env.AI binding；
#   - 本地走 REST /ai/run/{model}，凭据复用 wrangler 登录留下的 OAuth token，
#     过期了用 refresh_token 自动续（续完写回 toml，wrangler 那边也不用重新登录）。
# 旧方案（netcup 网关的 glm-5.3-flash）同日拆除：那网关把 flash 路由到带深度
# 思考的后端，回 30 字提示要先吐一千多字英文 reasoning，单次 27~60s，
# 12s 超时下「求灯永远回兜底句」；语音听写润色（/api/refine）一并移除。
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "").strip() or "f69671d00b6e139e4b7977ca5cd17758"
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "").strip()  # 服务器部署可放一个静态 API Token，优先于 wrangler 登录
WRANGLER_TOML = Path(
    os.environ.get("WRANGLER_CONFIG", "")
    or (Path(os.environ.get("APPDATA", "")) / "xdg.config" / ".wrangler" / "config" / "default.toml")
)
# dash.cloudflare.com 按 UA 签名拦 Python 默认 UA（error 1010），得带个浏览器 UA
_CF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36"
_CF_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7"  # wrangler CLI 内置的公共 OAuth client_id
_cf_lock = threading.Lock()
_cf_state = {"access": "", "expires": 0.0}  # expires 是 time.time() 口径的绝对过期时刻


def _toml_expiry(text: str) -> float:
    """wrangler toml 里的 expiration_time（UTC）转成本机 time.time() 口径；解析不了按已过期算。"""
    m = re.search(r'expiration_time\s*=\s*"([^"]+)"', text)
    if not m:
        return 0.0
    raw = m.group(1)
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.datetime.strptime(raw, fmt).replace(tzinfo=datetime.timezone.utc).timestamp()
        except ValueError:
            continue
    return 0.0


def _cf_refresh() -> str:
    """用 refresh_token 换新 access token 并写回 toml。失败返回空串（提示会退兜底句）。"""
    try:
        text = WRANGLER_TOML.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"[hint] 读不到 wrangler 凭据（{WRANGLER_TOML}）：{e}", flush=True)
        return ""
    m = re.search(r'refresh_token\s*=\s*"([^"]+)"', text)
    if not m:
        print("[hint] wrangler 凭据里没有 refresh_token，先跑一次 npx wrangler login", flush=True)
        return ""
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": m.group(1),
        "client_id": _CF_CLIENT_ID,
    }).encode("ascii")
    req = urllib.request.Request(
        "https://dash.cloudflare.com/oauth2/token", data=data, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": _CF_UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            tok = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[hint] OAuth 续期失败：{type(e).__name__}: {e}", flush=True)
        return ""
    access = str(tok.get("access_token") or "")
    if not access:
        print("[hint] OAuth 续期响应里没有 access_token", flush=True)
        return ""
    expires_in = int(tok.get("expires_in") or 3600)
    new_rt = str(tok.get("refresh_token") or m.group(1))
    new_exp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + expires_in))
    text = re.sub(r'(oauth_token\s*=\s*")[^"]+(")', lambda mm: mm.group(1) + access + mm.group(2), text)
    text = re.sub(r'(refresh_token\s*=\s*")[^"]+(")', lambda mm: mm.group(1) + new_rt + mm.group(2), text)
    text = re.sub(r'(expiration_time\s*=\s*")[^"]+(")', lambda mm: mm.group(1) + new_exp + mm.group(2), text)
    try:
        WRANGLER_TOML.write_text(text, encoding="utf-8")
    except OSError as e:
        print(f"[hint] 续期后写回 toml 失败（不影响本次使用）：{e}", flush=True)
    return access


def cf_ai_token() -> str:
    """拿到一个可用的 Workers AI access token；拿不到就空串。"""
    if CF_API_TOKEN:
        return CF_API_TOKEN
    now = time.time()
    with _cf_lock:
        if _cf_state["access"] and now < _cf_state["expires"] - 120:
            return _cf_state["access"]
        try:
            text = WRANGLER_TOML.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        expiry = _toml_expiry(text)
        if expiry > now + 120:
            m = re.search(r'oauth_token\s*=\s*"([^"]+)"', text)
            if m and m.group(1):
                _cf_state["access"] = m.group(1)
                _cf_state["expires"] = expiry
                return _cf_state["access"]
        access = _cf_refresh()
        if access:
            _cf_state["access"] = access
            _cf_state["expires"] = now + 3600  # 精确值已写回 toml，内存里给个保守缓存就行
        return access


def cf_ai_available() -> bool:
    """health 用：只查配置在不在，不发起网络请求。"""
    if CF_API_TOKEN:
        return True
    try:
        text = WRANGLER_TOML.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(re.search(r'refresh_token\s*=\s*"[^"]+"', text))

with PUZZLES_PATH.open(encoding="utf-8") as f:
    BUNDLE = json.load(f)
PUZZLES = {p["id"]: p for p in BUNDLE["puzzles"]}
HOST_ROLE = BUNDLE["host_role"]


def public_puzzle(p: dict) -> dict:
    return {
        "id": p["id"],
        "title": p["title"],
        "image": p["image"],
        "surface": p["surface"],
        # 难度标签（浅 / 中 / 深）：口径与分档见 tools/difficulty.py，值以 puzzles.json 为准
        "difficulty": p.get("difficulty", ""),
        # 汤色（清汤 / 红汤 / 黑汤）：口径见 tools/soup.py，值以 puzzles.json 为准。
        # 和 difficulty 是两个正交的轴 —— 那是「要问出几件事」，这是「要咽下什么」。
        "soup": p.get("soup", ""),
        "keys": [{"id": k["id"], "label": k["label"]} for k in p.get("keys", [])],
    }


# /api/puzzles 的响应体在启动时就算好。卷宗是随包发布的，进程跑起来不会再变，
# 每次请求现算一遍（44 卷 map + 二十来 KB 的 json.dumps）纯属白烧 CPU。
PUBLIC_PUZZLES_JSON = json.dumps(
    {"puzzles": [public_puzzle(p) for p in BUNDLE["puzzles"]]}, ensure_ascii=False
).encode("utf-8")


def typesafe(state: dict, questions: dict) -> tuple[dict, float]:
    if not TYPESAFE_KEY:
        raise RuntimeError("TYPESAFE_API_KEY missing")
    payload = json.dumps(
        {"state": state, "model": TYPESAFE_MODEL, "questions": questions},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        TYPESAFE_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {TYPESAFE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body, (time.perf_counter() - t0) * 1000


BASE_QUESTIONS = {
    "trying_to_extract": {
        "type": "noul",
        "instructions": "玩家是否在要求直接公布汤底、完整答案、或让主持人把故事讲出来？",
    },
    "is_full_guess": {
        "type": "noul",
        "instructions": "玩家是在陈述完整汤底/核心机制，而不是在问一个探测性是非题？",
    },
    "guess_correct": {
        "type": "noul",
        "instructions": "若当作完整猜测：是否已经抓住汤底核心机制？探测题即使方向对也不算猜中。",
    },
    "host_answer": {
        "type": "choice",
        "instructions": {
            "role": HOST_ROLE,
            "bias": (
                "先判这一问是真是假：能判真假就必须在是 / 不是 / 是也不是 里选一个，"
                "不要用无关、不重要、问清楚点来回避。"
                "近义也算：猥亵/性侵/奸尸/对尸体做那种事＝恋尸。"
                "命题分时点、分对象、分场景成立 —— 有时这样有时不这样 —— 那是「是也不是」，不是是也不是不是。"
                "「材料里没写」不等于「问清楚点」：汤底、cast 和 facts 都没写到的细节，"
                "问的是这个故事里的人或事就落 unimportant，跟故事完全无关就落 irrelevant。"
                "只有压根不是一句能判真假的人话（乱码、半句话、纯情绪）才选问清楚点。"
            ),
            "identity": (
                "人物身份（是男是女、是一个人还是两个人、谁是谁、什么亲属关系、某个称呼指的是谁）"
                "先看 cast：cast 里写明了（男 / 女 / 双性人这类）就是材料写明了 —— "
                "问到就按它判真假。玩家把性别或身份问反了（cast 写男、他问「是女的吗」）落「不是」，"
                "不许落「不重要」。汤面用 ta / 爱人 / 朋友 / 同学 / 有人 这类中性称呼，"
                "不等于材料没写：那是汤面故意藏的说法，cast 与汤底写了就是写了。"
                "cast 标「未写明」、或者 cast 里根本没有这个属性，才是材料真没写。"
                "cast 跟汤面的说法冲突时以 cast 为准（汤面本来就是障眼法）。"
                "同一个人物的身份在一局里固定：cast 写定了的属性，正反两个方向的问法必须一是一否，"
                "不许两边都落「不重要」，也不许跟 recent_history 里已经落过的印打架。"
                "**「指认」和「真假」要分开**：看问句问的是哪一头 —— "
                "问的是**人是谁**（「怀孕的是爱人吗」「怀孕的那个是 ta 吗」「唱歌的是你吗」"
                "「大哥是悟空吗」）落指认：照 cast 与 metaphor_map 的对应关系答，"
                "指的是那个人就落「是」，哪怕汤面那句话本身是假的"
                "（「爱人」就是汤面里怀孕的那个 —— 至于「怀孕」这件事是真是假，是另一问）。"
                "问的是**那件事、那个状态成不成立**（「爱人怀孕了吗」「你在唱歌吗」"
                "「他死了吗」）落真假：按汤底判，汤面是假象就落「不是」。"
            ),
            "method": (
                "先用 metaphor_map 把汤面用语翻译成汤底事实。问的是「谁」就对照 cast，"
                "问的是「发生/做了什么」就对照 facts。false 就是否定；"
                "cast 与 facts 里都没有这件事，就落 unimportant / irrelevant，不要判成「不是」。"
            ),
        },
        "criteria": {
            "yes": "对照汤底、cast 与 facts，该命题为真。包括近义问法。",
            "no": "对照汤底、cast 与 facts，该命题为假。玩家把身份或性别问反了也落这一项。",
            "both": (
                "命题分情况：换个时点 / 换个对象 / 换个场景就不成立，两头都咬在汤底上。"
                "典型是「这个人死了吗」而汤底里他死过又回来；或者同一句话里两个分句一对一错、"
                "而两边都是汤底主干。只有确实两头都站得住才用这一项，禁止拿它和稀泥。"
            ),
            "partial": "一句话里有对有错，但错的那半只是旁枝，不影响这一问的主干。",
            "close": "摸到关键机制，但还没说圆。不要用这项代替是/否。",
            "irrelevant": "跟这个故事完全无关（问天气、问主持人本身），答了也对还原汤底没帮助。",
            "unimportant": (
                "问的确实是这个故事里的人或事，但答对答错都不改变汤底 —— 只影响细节、不影响机制。"
                "比 irrelevant 贴题，比 yes/no 没用。"
                "cast 标「未写明」的身份属性（性别、年龄），以及汤底、cast、facts 都没写到的细节"
                "（地点、穿着、楼层）一律落这一项，不要落 unanswerable。"
            ),
            "unanswerable": (
                "压根不是一句能判真假的人话：乱码、半句话、纯情绪、只丢一个词。"
                "材料里没写不是这一项（那是 unimportant / irrelevant）；能判真假就禁止选这项。"
            ),
        },
    },
}


def build_questions(puzzle: dict) -> dict:
    questions = dict(BASE_QUESTIONS)
    for key in puzzle.get("keys") or []:
        expect = "是" if key.get("expect", True) else "不是"
        questions[f"key_{key['id']}"] = {
            "type": "noul",
            "instructions": (
                "玩家这一句是否实质问到了下面这个关键点？近义、隐喻都算。"
                f"关键点：{key['prompt']} 期望主持人回答「{expect}」。"
                "只有指向该点才给高分；无关闲问给低分。"
            ),
        }
    return questions


def pick_host(choice: str, probabilities: dict) -> str:
    """定最终那枚印。

    「是也不是」要先于「是 / 不是」判：这种题的两边概率本来就都高
    （旧写法 yes+no >= 0.45 就直接取大的那个），正好把「有时是、有时不是」
    判成错的那一半。所以只要 both 够高、且 yes / no 也都不低，就先认 both。

    其次是「问清楚点」的兜底回收：模型自己选了 unanswerable（或回了个档位外的
    词）时，先看它是不是把分量压在「不重要 / 无关」上 —— 那说明这一问它听懂了、
    只是汤底没写，不该挨「问清楚点」。见 SOFT_RESCUE_* 的注释。
    """
    probs = {k: float(v) for k, v in (probabilities or {}).items()}
    yes_p = probs.get("yes", 0.0)
    no_p = probs.get("no", 0.0)
    both_p = probs.get("both", 0.0)
    if both_p >= 0.3 and min(yes_p, no_p) >= 0.18 and both_p >= max(yes_p, no_p) - 0.2:
        return "both"
    if yes_p + no_p >= 0.45:
        return "yes" if yes_p >= no_p else "no"
    if choice in HOST_LABELS and choice != "unanswerable":
        return choice
    # 走到这里只剩两种情况：模型自己说「问清楚点」，或者它回了个不在档位里的词
    # —— 在模型那儿这两件事是一件事：这一问它没法对着汤底判真假。
    soft = "unimportant" if probs.get("unimportant", 0.0) >= probs.get("irrelevant", 0.0) else "irrelevant"
    soft_p = probs.get(soft, 0.0)
    if soft_p >= SOFT_RESCUE_MIN and soft_p >= probs.get("unanswerable", 0.0) * SOFT_RESCUE_RATIO:
        return soft
    if choice in HOST_LABELS:
        return choice
    if max(yes_p, no_p) >= 0.28:
        return "yes" if yes_p >= no_p else "no"
    return "unanswerable"


def judge(puzzle: dict, utterance: str, history: list, unlocked: list | None = None) -> dict:
    keys = puzzle.get("keys") or []
    found = {k for k in (unlocked or []) if isinstance(k, str)}
    state = {
        "title": puzzle["title"],
        "surface": puzzle["surface"],
        "bottom": puzzle["bottom"],
        "metaphor_map": puzzle["metaphor_map"],
        "facts": puzzle["facts"],
        "player_utterance": utterance,
        "recent_history": history[-8:],
        # 人物表：谁是谁、是男是女、材料没写就写「未写明」。没有它的时候，身份类问题
        # （「爱人是男的吗」）只能凭汤底代词猜 —— 实测同一问连打三次会在「是」与
        # 「不重要」之间抖。见 tools/cast.py。
        #
        # **它必须排在最后**，这不是排版洁癖：《怀孕》的「怀孕的是爱人吗」在
        # 「cast 放在 facts 后面」时稳定答「是」（y .52–.58），放到末尾后稳定答
        # 「不是」（n .63–.73）—— 交错 4 轮、4:4，见 tmp/_order_ab.py。
        # 身份题两种顺序都满分（tools/cast-check.py 18/18），所以按事件题这半边定。
        "cast": puzzle.get("cast") or [],
    }
    raw, latency_ms = typesafe(state, build_questions(puzzle))
    answers = raw.get("answers", {})
    host = answers.get("host_answer", {})
    extract = float(answers.get("trying_to_extract", {}).get("noul", 0))
    full_guess = float(answers.get("is_full_guess", {}).get("noul", 0))
    guess_ok = float(answers.get("guess_correct", {}).get("noul", 0))
    probabilities = host.get("probabilities") or {}
    choice = pick_host(host.get("choice") or "unanswerable", probabilities)
    confidence = float(host.get("confidence") or 0)

    if full_guess >= 0.75 and guess_ok >= 0.78:
        found.update(k["id"] for k in keys)
    else:
        for key in keys:
            score = float(answers.get(f"key_{key['id']}", {}).get("noul", 0))
            # 「是也不是」也算问到了这个关键点：题目本来就只有一半是「是」
            if score >= 0.55 and choice in ("yes", "no", "both", "close", "partial"):
                found.add(key["id"])

    solved = bool(keys) and all(k["id"] in found for k in keys)
    if extract >= 0.85 and not solved:
        verdict = "refuse"
        label = "不能剧透"
        say = "规则是：你问，我只答是、不是、是也不是这些。汤底要自己问出来。"
    elif solved:
        verdict = "solved"
        label = "结案"
        say = "关键点已经齐了。"
    else:
        verdict = choice if choice in HOST_LABELS else "unanswerable"
        label = HOST_LABELS.get(verdict, HOST_LABELS["unanswerable"])
        say = {
            "yes": "是。",
            "no": "不是。",
            "both": "是也不是。",
            "irrelevant": "无关。",
            "unimportant": "不重要。",
            "partial": "部分对。",
            "close": "接近了。",
            "unanswerable": "问清楚点。",
        }.get(verdict, "问清楚点。")

    key_view = [
        {"id": k["id"], "label": k["label"], "found": k["id"] in found}
        for k in keys
    ]
    return {
        "ok": True,
        "label": label,
        "say": say,
        "verdict": verdict,
        "solved": solved,
        "unlocked": sorted(found),
        "keys": key_view,
        "latency_ms": round(latency_ms),
        "judge": {
            "choice": choice,
            "confidence": round(confidence, 3),
            "probabilities": {k: round(float(v), 3) for k, v in probabilities.items()},
            "extract": round(extract, 3),
            "full_guess": round(full_guess, 3),
            "guess_ok": round(guess_ok, 3),
            "model": raw.get("model"),
            "usage": raw.get("usage"),
        },
        "bottom": puzzle["bottom"] if solved else None,
    }


# ================= 两份数据文件的读写 =================
#
# data/board.json（排行榜）和 data/stats.json（埋点）都是「读-改-写」的小文件。
# 旧写法每次请求都 read_text + json.loads 一遍：/api/board 每换一卷打一次、
# /api/score 每次结案打一次、/api/track 每 20 秒打一次 —— 全是白烧的磁盘和 CPU。
# 现在内存里各留一份，靠 **文件 mtime** 判断外面有没有人动过（手改、tools 里的脚本
# 直接写盘都认得出来），自己写完立刻把缓存接上。
#
# 写入一律先写 .tmp 再 os.replace：同一分区上的 replace 是原子的，
# 半截 JSON 不会留在盘上 —— 排行榜被写成半截，下一次读就是整份丢。
#
# _DATA_LOCK 是叶子锁（写盘 + 更新缓存），用 RLock 是因为 save_* 会从
# 已经持锁的读-改-写里被调用。
_DATA_LOCK = threading.RLock()
_BOARD_CACHE: dict = {"mtime": -1.0, "data": None}
_STATS_CACHE: dict = {"mtime": -1.0, "data": None}


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_cached(path: Path, cache: dict, factory):
    """带 mtime 记忆的 JSON 读取。读到的不是 dict（或读坏了）就退回 factory()。"""
    with _DATA_LOCK:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            cache["mtime"], cache["data"] = -1.0, None
            return factory()
        if cache["data"] is not None and cache["mtime"] == mtime:
            return cache["data"]
        data = None
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            data = None
        if data is None:
            cache["mtime"], cache["data"] = -1.0, None
            return factory()
        cache["mtime"], cache["data"] = mtime, data
        return data


def save_board(board: dict) -> None:
    with _DATA_LOCK:
        _atomic_write(BOARD_PATH, json.dumps(board, ensure_ascii=False, indent=2))
        _BOARD_CACHE["data"] = board
        try:
            _BOARD_CACHE["mtime"] = BOARD_PATH.stat().st_mtime
        except OSError:
            _BOARD_CACHE["mtime"] = -1.0


def load_board() -> dict:
    return _read_cached(BOARD_PATH, _BOARD_CACHE, dict)


# ---------- 每卷「几人已结案」 ----------
#
# **不能拿排行榜的行数当人数**：每卷只留前 30 行（按问数、用时排），
# 第 31 个人虽然结案了，行却被挤掉。所以单独记一张 {卷id: 人数}，
# 只在「这一卷第一次见到这个 player id」时 +1（player id 是浏览器本地生成的随机串）。
#
# 已知偏差，别当精确账：超过 30 人之后，被挤出前 30 的那位再结一次会被多算一次。
# 这个数只是给玩家看的「这一卷有没有人通过」，不是排行榜的账。
SOLVES_PATH = DATA / "solves.json"
_SOLVES_CACHE: dict = {"mtime": -1.0, "data": None}


def load_solves() -> dict:
    """人数表。**第一次被读到时从现有的榜回填一次** ——
    这张表是 2026-09-20 才加的，而榜上那时候已经有玩家结过案了：
    不回填就会出现「榜上有人、人数写 0」，下一位还会被谎报成「第 1 位」。
    只在文件缺失时做（写完就再也不进这里）。"""
    if not SOLVES_PATH.is_file():
        return rebuild_solves()
    return _read_cached(SOLVES_PATH, _SOLVES_CACHE, dict)


def rebuild_solves() -> dict:
    """按现有各卷榜重算人数（首读回填与后台修复共用）。
    口径是「榜上还留着几个人」，所以超过 30 人的卷会被算成 30 ——
    这是**修复**手段，不是日常记账。"""
    counts = {}
    try:
        for pid, rows in load_board().items():
            if isinstance(rows, list) and rows:
                counts[pid] = len(rows)
        save_solves(counts)
    except Exception as exc:
        print("[solves] 回填失败：%s" % exc, flush=True)
    return counts


def save_solves(data: dict) -> None:
    with _DATA_LOCK:
        _atomic_write(SOLVES_PATH, json.dumps(data, ensure_ascii=False, indent=2))
        _SOLVES_CACHE["data"] = data
        try:
            _SOLVES_CACHE["mtime"] = SOLVES_PATH.stat().st_mtime
        except OSError:
            _SOLVES_CACHE["mtime"] = -1.0


def bump_solves(puzzle_id: str, is_new_player: bool) -> int:
    """记一个人数并回当前值。**同一个 player 重复结案不重复计人**。"""
    with _DATA_LOCK:
        data = load_solves()
        count = int(data.get(puzzle_id) or 0)
        if is_new_player:
            count += 1
            data[puzzle_id] = count
            save_solves(data)
        return count


def upsert_score(puzzle_id: str, player_id: str, name: str, asks: int, ms: int,
                 used_hint: bool = False) -> tuple[list, bool]:
    """记一次结案。整段读-改-写都在 _DATA_LOCK 里 —— 旧写法没上锁，
    同一卷两个人几乎同时结案时，后写的那个会把先写的那条覆盖掉（丢一条成绩）。"""
    name = (name or "夜馆").strip()[:8]
    asks = max(1, int(asks))
    ms = max(1, int(ms))
    used_hint = bool(used_hint)
    with _DATA_LOCK:
        board = load_board()
        rows = board.setdefault(puzzle_id, [])
        found = None
        for row in rows:
            if row.get("id") == player_id:
                found = row
                break
        is_new = found is None      # 榜上原来没有他 = 这个人第一次结这一卷
        if found:
            if asks < found.get("asks", 10**9) or (asks == found.get("asks") and ms < found.get("ms", 10**12)):
                found.update({"name": name, "asks": asks, "ms": ms, "used_hint": used_hint})
            else:
                found["name"] = name
        else:
            rows.append({"id": player_id, "name": name, "asks": asks, "ms": ms, "used_hint": used_hint})
        rows.sort(key=lambda r: (r.get("asks", 99), r.get("ms", 10**12)))
        board[puzzle_id] = rows[:30]
        save_board(board)
        # is_new：这一卷的榜上原来没有这个 player id（= 这个人第一次结这一卷）
        return board[puzzle_id], is_new


FALLBACK_HINT = "对照汤面里最不对劲的那一句，问它是不是字面意思。"


def leaks_bottom(text: str, bottom: str) -> bool:
    """提示里要是出现汤底中连续 8 个字，就当成在复述汤底，这一句弃用。

    取 8 是因为：正常一句 40 字的提示跟汤底撞满 8 个连续字几乎不可能
    （撞上基本就是照抄），而抄汤底半句必然命中。只靠 system prompt 里
    那句「绝不写出汤底」挡不住 8B 级小模型，这里补一道机械闸。
    比对前把空白全去掉 —— 汤底里换行、缩进很多，不去掉会漏判。"""
    t = "".join(ch for ch in (text or "") if not ch.isspace())
    b = "".join(ch for ch in (bottom or "") if not ch.isspace())
    if len(t) < 8 or len(b) < 8:
        return False
    grams = {b[i:i + 8] for i in range(len(b) - 7)}
    return any(t[i:i + 8] in grams for i in range(len(t) - 7))


# 求灯的模型链，与 functions/api/[[path]].js 的 HINT_MODELS 1:1：
# 第一个是主力，出错 / 抠不出正文 / 撞泄底闸就依次往下退。
# 实测数据（tmp/_o_aisweep.txt）：70b-fp8-fast 中文最稳、1~2s、每次都出正文；
# 8b 会偶尔把「同桌」直接写出来；mistral 中文最利落。
HINT_MODELS = [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
]

HINT_SYSTEM = (
    "你是海龟汤馆的掌灯人。根据汤底和问答，给一句中文提示。只指向还没问到的方向，"
    "绝不写出汤底、人名对照或完整机制，也不要照抄汤底里的任何整句。"
    "不要用「汤底是」「其实是」开头。不要英文。只要一句，不超过 40 字。"
)


def cf_ai_run(model: str, messages: list, timeout_s: float = 20.0) -> dict:
    """跑一次 Workers AI（REST）。OAuth token 过期（401）会自动续一次再试。"""
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/{model}"
    body = json.dumps({"messages": messages, "max_tokens": 80, "temperature": 0.4},
                      ensure_ascii=False).encode("utf-8")
    for _ in range(2):
        token = cf_ai_token()
        if not token:
            raise RuntimeError("没有可用的 Cloudflare 凭据（设 CF_API_TOKEN，或跑一次 npx wrangler login）")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": _CF_UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:160]
            if e.code == 401 and not CF_API_TOKEN:
                with _cf_lock:
                    _cf_state["access"] = ""  # token 刚过期，清缓存强制下一次续期
                continue
            raise RuntimeError(f"HTTP {e.code} {detail}")
    raise RuntimeError("Workers AI 连续两次 401，续期后仍不可用")


def pick_ai_text(res) -> str:
    """Workers AI 返回形状不止一种，全兜住（与线上 pickAiText 同款）：
    llama-3.1-8b → {response:"..."}；其余多为 {result:{choices:[{message:{content}}]}}；
    binding 还会多一层 result 外壳。抠不出正文返回空串。"""
    if not isinstance(res, dict):
        return ""
    inner = res.get("result") if isinstance(res.get("result"), dict) else res
    r = inner.get("response")
    if isinstance(r, str) and r.strip():
        return r
    choices = inner.get("choices") or []
    if choices and isinstance(choices[0], dict):
        content = (choices[0].get("message") or {}).get("content")
        if isinstance(content, str) and content.strip():
            return content
    return ""


def clip_hint(text: str) -> str:
    """掐掉首尾引号/括号、压平空白，超 48 截断 —— 与线上 clipHint 同款。"""
    out = re.sub(r"\s+", " ", str(text or "")).strip()
    return re.sub(r'^["「『]+|[」』"]+$', "", out)[:48]


def make_hint(puzzle: dict, history: list, unlocked: list, prev: str = "") -> tuple[str, str]:
    """返回 (hint, model)。模型链全挂时 hint=FALLBACK_HINT、model=""。"""
    keys = puzzle.get("keys") or []
    found = {k for k in (unlocked or []) if isinstance(k, str)}
    missing = [k for k in keys if k.get("id") not in found]
    # 已经求过一次灯的，第二次就指「下一个还没点亮的方向」，别在原地打转
    pick = 1 if (prev and len(missing) > 1) else 0
    target = missing[pick]["prompt"] if missing else "还有一层隐喻没问到。"
    turns = []
    for h in (history or [])[-8:]:
        if not isinstance(h, dict):
            continue
        q = h.get("question") or (h.get("text") if h.get("role") == "player" else "")
        a = h.get("label") or (h.get("text") if h.get("role") == "host" else "")
        if q:
            turns.append(f"问：{q}" + (f" → {a}" if a else ""))
    asked = (
        f"\n刚才已经给过他一句提示：{prev}\n换一个角度补充，不要跟这句重复、不要只是换个说法。"
        if prev
        else ""
    )
    user = (
        f"卷宗《{puzzle['title']}》\n汤面：{puzzle['surface']}\n汤底（保密）：{puzzle['bottom']}\n"
        f"尚未点亮的方向：{target}{asked}\n最近问答：\n" + ("\n".join(turns) or "还没问过") + "\n请给一句提示。"
    )
    notes = []
    for model in HINT_MODELS:
        short = model.rsplit("/", 1)[-1]
        try:
            raw = pick_ai_text(cf_ai_run(model, [
                {"role": "system", "content": HINT_SYSTEM},
                {"role": "user", "content": user},
            ]))
        except Exception as e:
            notes.append(f"{short}:{e}")
            continue
        if not raw:
            notes.append(f"{short}:空")
            continue
        out = clip_hint(raw)
        if not out:
            notes.append(f"{short}:裁空")
            continue
        if leaks_bottom(out, puzzle.get("bottom", "")):
            notes.append(f"{short}:泄底闸拦下")
            continue
        return out, model
    if notes:
        # 失败原因打到控制台 —— 静默吞掉的话，线上只能看到「永远回同一句兜底」
        print("[hint] 模型链全退到兜底：" + " | ".join(notes)[:300], flush=True)
    return FALLBACK_HINT, ""


# ================= 埋点与按天聚合（与 functions/api/[[path]].js 1:1 对齐） =================
#
# 本地版把 KV 换成 data/stats.json 一个文件，字段名、日期切法、UV 去重规则
# 都跟线上一致 —— 这样离线测出来的结论在线上成立。
#
#   {"days": {"YYYY-MM-DD": {"c": {...}, "p": {...}}},
#    "seen": {"YYYY-MM-DD": ["<uid>", ...]},
#    "first": {"<uid>": "YYYY-MM-DD"},
#    "rl": {"<ip>": [失败次数, 过期时间戳]}}
#
# 事件分两条路记，别再混成一条（2026-09-20 那场「后台不动」就是混出来的）：
#
#   服务端自己数：ask / hint / solve / give —— 这四件事服务端**当场就知道**
#     （谁问了、谁求了灯、谁放弃、判题判没判成结案），所以由接口自己记一笔，
#     见下面 bump_track()，不再经过浏览器。
#   客户端上报：只剩 pv（开卷成功）。这件服务端看不见 —— /api/puzzles 带 60 秒缓存，
#     同一个访客一分钟内再开卷压根打不到服务端，只能由页面自己报。
#
# 为什么要把前四个从客户端搬到服务端：它们原先全靠 web/app.js 攒批上报，
# 而上报代码要等下一次部署才生效。线上跑着旧 app.js 的那段时间里，后台的
# 提问/求灯/结案全是 0，偏偏访问量还在涨 —— 看起来像「后台坏了」，其实是
# 账本抄在一份可能过期的副本上。服务端看得见的事就别外包给前端。
TRACK_CLIENT_KINDS = ("pv",)          # 客户端还能报的
BUMP_KINDS = ("ask", "hint", "solve", "give")   # 服务端自己数的
BUMP_PUZZLE_KINDS = ("ask", "hint", "solve")    # 其中要记到分卷明细的
TRACK_MAX_EVENTS = 240
SEEN_TTL = 60 * 24 * 60 * 60
SEEN_CAP = 3000

ADMIN_TTL_MS = 12 * 3600 * 1000
LOGIN_WINDOW_S = 900
LOGIN_MAX_FAIL = 8

STATS_PATH = DATA / "stats.json"
ADMIN_KEY = os.environ.get("ADMIN_KEY", "").strip()
_stats_lock = threading.Lock()


def shanghai_date(offset_days: int = 0) -> str:
    """按 Asia/Shanghai 切日期。本地就是 +8，线上 Worker 跑 UTC 才需要换算，两边写法统一。"""
    stamp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        hours=8, days=offset_days
    )
    return stamp.date().isoformat()


def sanitize_uid(value) -> str:
    text = str(value or "")
    return text if re.fullmatch(r"[A-Za-z0-9_-]{6,40}", text) else ""


def _empty_stats() -> dict:
    return {"days": {}, "seen": {}, "first": {}, "rl": {}}


def load_stats() -> dict:
    data = _read_cached(STATS_PATH, _STATS_CACHE, _empty_stats)
    for key in ("days", "seen", "first", "rl"):
        data.setdefault(key, {})
    return data


def save_stats(data: dict) -> None:
    with _DATA_LOCK:
        _atomic_write(STATS_PATH, json.dumps(data, ensure_ascii=False))
        _STATS_CACHE["data"] = data
        try:
            _STATS_CACHE["mtime"] = STATS_PATH.stat().st_mtime
        except OSError:
            _STATS_CACHE["mtime"] = -1.0


def apply_track(date: str, events: list, uid: str) -> bool:
    """客户端上报：只认 pv，外加 uid（用来算 UV / 新增）。

    别的 k 一律不认 —— 认了就跟服务端自己数的那份重复计数了。
    旧客户端还在报 ask/hint/solve/give（线上那份 app.js 就还在报 give），
    它们正好被这一行滤掉，新旧前端混着跑也不会把账记双。"""
    with _stats_lock:
        data = load_stats()
        day = data["days"].setdefault(date, {"c": {}, "p": {}})
        day.setdefault("c", {})
        day.setdefault("p", {})
        for ev in events:
            kind = str((ev or {}).get("k") or "")
            if kind not in TRACK_CLIENT_KINDS:
                continue
            day["c"][kind] = int(day["c"].get(kind, 0)) + 1
        is_new = False
        if uid:
            seen = data["seen"].setdefault(date, [])
            if uid not in seen:
                seen.append(uid)
                del seen[:-SEEN_CAP]
                day["c"]["uv"] = int(day["c"].get("uv", 0)) + 1
            is_new = uid not in data["first"]
            if is_new:
                data["first"][uid] = date
                day["c"]["new"] = int(day["c"].get("new", 0)) + 1
        save_stats(data)
        return is_new


def bump_track(kind: str, pid: str = "") -> None:
    """接口自己记一笔（ask / hint / solve / give）。

    日期在这里现算，不接调用方传进来的 —— 服务是常驻的，跨零点那一刻要用当天的。
    出错只打一行日志：埋点坏了不能影响玩，更不能把判题结果吞掉。"""
    if kind not in BUMP_KINDS:
        return
    try:
        with _stats_lock:
            data = load_stats()
            day = data["days"].setdefault(shanghai_date(0), {"c": {}, "p": {}})
            day.setdefault("c", {})
            day.setdefault("p", {})
            day["c"][kind] = int(day["c"].get(kind, 0)) + 1
            pid = str(pid or "").strip()[:32]
            if pid and kind in BUMP_PUZZLE_KINDS:
                row = day["p"].setdefault(pid, {})
                row[kind] = int(row.get(kind, 0)) + 1
            save_stats(data)
    except Exception as exc:
        print("[track] %s 没记上：%s" % (kind, exc), flush=True)


# ---------- 后台登录 ----------


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * ((4 - len(text) % 4) % 4))


def mint_token() -> str:
    payload = _b64url(
        json.dumps({"exp": int(time.time() * 1000) + ADMIN_TTL_MS}).encode("utf-8")
    )
    sig = hmac.new(ADMIN_KEY.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    return payload + "." + _b64url(sig)


def token_ok(token: str) -> bool:
    if not ADMIN_KEY or not isinstance(token, str) or "." not in token or len(token) > 4000:
        return False
    payload, _, sig = token.partition(".")
    expect = hmac.new(ADMIN_KEY.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    try:
        given = _b64url_decode(sig)
    except Exception:
        return False
    if not secrets.compare_digest(expect, given):
        return False
    try:
        return int(json.loads(_b64url_decode(payload)).get("exp", 0)) > time.time() * 1000
    except Exception:
        return False


def admin_login(ip: str, body: dict) -> tuple[int, dict]:
    if not ADMIN_KEY:
        return 503, {"ok": False, "error": "后台没配密钥：设一个 ADMIN_KEY 环境变量"}
    with _stats_lock:
        data = load_stats()
        fails, until = (data["rl"].get(ip) or [0, 0])[:2]
        if time.time() > until:
            fails = 0
        if fails >= LOGIN_MAX_FAIL:
            return 429, {"ok": False, "error": "试太多次了，过 15 分钟再来"}
        given = str((body or {}).get("key") or "")
        if not given or not secrets.compare_digest(given, ADMIN_KEY):
            data["rl"][ip] = [fails + 1, time.time() + LOGIN_WINDOW_S]
            save_stats(data)
            return 401, {"ok": False, "error": "密钥不对", "left": max(0, LOGIN_MAX_FAIL - fails - 1)}
        data["rl"].pop(ip, None)
        save_stats(data)
    return 200, {"ok": True, "token": mint_token(), "ttl_ms": ADMIN_TTL_MS}


def collect_stats(days: int) -> dict:
    data = load_stats()
    dates = [shanghai_date(-i) for i in range(days - 1, -1, -1)]
    keys = ("pv", "uv", "new", "ask", "hint", "solve", "give")
    series = []
    totals = {k: 0 for k in keys}
    per_puzzle: dict = {}
    for date in dates:
        day = data["days"].get(date) or {}
        counts = day.get("c") or {}
        row = {"date": date}
        for key in keys:
            row[key] = int(counts.get(key, 0) or 0)
            totals[key] += row[key]
        series.append(row)
        for pid, value in (day.get("p") or {}).items():
            acc = per_puzzle.setdefault(pid, {"ask": 0, "hint": 0, "solve": 0})
            for key in ("ask", "hint", "solve"):
                acc[key] += int((value or {}).get(key, 0) or 0)
    puzzles = [
        {
            "id": pid,
            "title": (PUZZLES.get(pid) or {}).get("title", pid),
            "ask": value["ask"],
            "hint": value["hint"],
            "solve": value["solve"],
        }
        for pid, value in per_puzzle.items()
    ]
    puzzles.sort(key=lambda r: (-r["ask"], -r["solve"]))
    return {"ok": True, "today": shanghai_date(0), "days": series, "totals": totals,
            "puzzles": puzzles, "window": days}


_GZIP_CACHE: dict = {}
_GZIP_LOCK = threading.Lock()


def _gzip_for(path: Path, mtime: float, size: int) -> bytes:
    """文本类静态资源的压缩结果按 (mtime, size) 记住。改文件就自动失效。
    这里用 9 档：一份文件只压一次，之后都是重放，值得多花那点 CPU。"""
    key = str(path)
    with _GZIP_LOCK:
        hit = _GZIP_CACHE.get(key)
        if hit and hit[0] == mtime and hit[1] == size:
            return hit[2]
        blob = gzip.compress(path.read_bytes(), 9)
        _GZIP_CACHE[key] = (mtime, size, blob)
        return blob


class Handler(SimpleHTTPRequestHandler):
    """本机 / 自建服务器用的处理程序。

    HTTP/1.1 + keep-alive：一页要开五十来个请求（44 张封面 + css/js + 字体），
    默认的 HTTP/1.0 是「一个请求一条 TCP 连接」，每条都要重新握手、再起一个线程。
    打开 keep-alive 之后这一串复用同一条连接，首屏快一截。

    timeout 是给 keep-alive 兜底的：连着不说话的连接到点自己断 ——
    不然一个开着页面就走掉的浏览器会一直占着一个线程（线程数只增不减才是真的漏）。
    """

    protocol_version = "HTTP/1.1"
    timeout = 65

    # gzip 只压文本类：图 / 字体本来就是压缩过的，再压一道纯亏 CPU
    GZIP_TYPES = (".html", ".css", ".js", ".json", ".svg", ".txt", ".webmanifest")
    GZIP_MIN = 1024

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webp": "image/webp",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def log_error(self, fmt: str, *args) -> None:
        # keep-alive 连接超时是正常收尾，别每 65 秒往控制台吐一行
        if "timed out" in (fmt % args):
            return
        super().log_error(fmt, *args)

    def send_response(self, code, message=None):
        self._status = code
        super().send_response(code, message)

    def _cache_control(self, path: str) -> str:
        if path.endswith((".png", ".webp", ".jpg", ".jpeg", ".svg", ".woff2")):
            # 封面文件名不含 hash，一天够用；改图后第二天各端自己换新
            return "public, max-age=86400"
        if path.endswith((".css", ".js")):
            # 前端用 ?v= 做版本，命中新 URL 就是新文件
            return "public, max-age=31536000, immutable"
        if path.endswith(".html") or path in ("", "/"):
            return "no-cache"
        return ""

    def end_headers(self) -> None:
        path = urllib.parse.urlparse(self.path).path.lower()
        status = getattr(self, "_status", 0)
        if status in (200, 304) and not path.startswith("/api") and not self._cc_sent:
            cc = self._cache_control(path)
            if cc:
                self.send_header("Cache-Control", cc)
        super().end_headers()

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _not_modified_since(self, mtime: float) -> bool:
        raw = self.headers.get("If-Modified-Since")
        if not raw:
            return False
        try:
            return int(mtime) <= int(parsedate_to_datetime(raw).timestamp())
        except Exception:
            return False

    def _serve_gzip_static(self, path: str) -> bool:
        """文本类静态资源直接吐压好的字节，带 ETag / Last-Modified，能 304。答完了返回 True。

        为什么绕开 SimpleHTTPRequestHandler 那条路：它的响应头在 send_head() 里就发出去了，
        等 copyfile() 想压的时候已经改不了 Content-Length。这里只截文本类，
        图 / 字体仍走原路（它们本来就压过了）。

        `/` 要单独认成 index.html —— 首页那 10KB HTML 正是最该压的一份。"""
        if path.startswith("/api") or not self._accepts_gzip() or self.headers.get("Range"):
            return False
        if path in ("", "/"):
            target = WEB / "index.html"
            ext = ".html"
        else:
            ext = os.path.splitext(path)[1].lower()
            target = (WEB / urllib.parse.unquote(path).lstrip("/")).resolve()
        if ext not in self.GZIP_TYPES:
            return False
        if not target.is_relative_to(WEB) or not target.is_file():
            return False
        try:
            st = target.stat()
        except OSError:
            return False
        if st.st_size < self.GZIP_MIN:
            return False
        etag = '"%x-%x-gz"' % (int(st.st_mtime), st.st_size)
        last_mod = self.date_time_string(int(st.st_mtime))
        cache = self._cache_control(path) or "no-cache"
        self._cc_sent = True  # 别让 end_headers 再发一遍 Cache-Control
        if self.headers.get("If-None-Match") == etag or self._not_modified_since(st.st_mtime):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", last_mod)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return True
        body = _gzip_for(target, st.st_mtime, st.st_size)
        self.send_response(200)
        # Content-Type 走标准库自己的 guess_type：我们那份 extensions_map 只补了
        # webp / js / css / json / woff2，**.html 不在里面** —— 直接查 map 会掉到
        # application/octet-stream，而「text/plain 之外的非渲染类型 + gzip」会让浏览器
        # 把首页当文件下载：页面停在 about:blank，所有探针都量不到 DOM。
        # guess_type 查不到时会回落到 mimetypes，.html 就是它认识的。
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", last_mod)
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)
        return True

    def _send_bytes(self, code: int, data: bytes, cache: str = "no-store",
                    content_type: str = "application/json; charset=utf-8") -> None:
        """发一段自己拼好的响应体（JSON 或预计算好的那 18KB 卷宗）。够大就 gzip。"""
        gz = gzip.compress(data, 6) if (len(data) >= self.GZIP_MIN and self._accepts_gzip()) else None
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        if gz is not None:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(gz) if gz is not None else len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(gz if gz is not None else data)

    def _json(self, code: int, payload: dict, cache: str = "no-store") -> None:
        self._send_bytes(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), cache)

    def _read_body(self) -> bytes:
        if self._body is not None:
            return self._body
        length = int(self.headers.get("Content-Length") or 0)
        self._body = self.rfile.read(length) if length > 0 else b""
        return self._body

    def _read_json(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            # 请求体不是 UTF-8（旧客户端 / 别的编码发的）要当成「JSON 坏了」报 400，
            # 不能让它以 UnicodeDecodeError 冒出去 —— 那会直接打死这个请求的处理线程，
            # 客户端只看到一个没头没尾的 empty reply，什么都查不出来。
            raise json.JSONDecodeError("body is not utf-8", str(exc), 0)
        return json.loads(text)

    def _token(self) -> str:
        header = self.headers.get("Authorization") or ""
        return header[7:].strip() if header.lower().startswith("bearer ") else ""

    def _admin_guard(self) -> bool:
        """放行返回 True；否则响应已经写完，返回 False。"""
        if not ADMIN_KEY:
            self._json(503, {"ok": False, "error": "后台没配密钥：设一个 ADMIN_KEY 环境变量"})
            return False
        if not token_ok(self._token()):
            self._json(401, {"ok": False, "error": "unauthorized"})
            return False
        return True

    def do_GET(self) -> None:
        raw_path = urllib.parse.urlparse(self.path).path
        # 文本类静态资源（css / js / html）走预压缩那条路，答完就返回
        if self._serve_gzip_static(raw_path):
            return
        path = raw_path.rstrip("/") or "/"
        if path == "/api/health":
            self._json(
                200,
                {
                    "ok": True,
                    "typesafe": bool(TYPESAFE_KEY),
                    "puzzles": len(PUZZLES),
                    # 语音识别挪到浏览器端（SpeechRecognition），服务端不再挂模型
                    "stt": "browser",
                    "hint": cf_ai_available(),
                    "hint_model": HINT_MODELS[0],
                    "hint_fallbacks": len(HINT_MODELS),
                    # 判题模型：不设备胎、不许被变量顶掉，这里报的永远是那个唯一解
                    "judge_model": TYPESAFE_MODEL,
                    "stats": True,
                    "admin": bool(ADMIN_KEY),
                },
            )
            return
        if path == "/api/solves":
            # 每卷「几人已结案」。**故意与 /api/puzzles 分开**：那份卷宗是启动时算好、
            # 之后几十年不变的（还带 60 秒缓存），人数却是每次结案都会变的 ——
            # 混在一起就得为它把整份 18KB 重新序列化，不值。
            self._send_bytes(
                200,
                json.dumps({"ok": True, "solves": load_solves()}, ensure_ascii=False).encode("utf-8"),
                "public, max-age=30",
            )
            return
        if path == "/api/puzzles":
            # 与线上同一条规矩：卷宗是随包发布的，给浏览器 60 秒缓存（省掉那 18KB 重发）
            self._send_bytes(200, PUBLIC_PUZZLES_JSON,
                             "public, max-age=60, stale-while-revalidate=600")
            return
        if path == "/api/admin/probe":
            self._json(200, {"ok": True, "configured": bool(ADMIN_KEY), "kv": True})
            return
        if path.startswith("/api/admin/"):
            if not self._admin_guard():
                return
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if path == "/api/admin/stats":
                try:
                    days = int((qs.get("days") or ["30"])[0])
                except ValueError:
                    days = 30
                self._json(200, collect_stats(days if days in (7, 14, 30, 90) else 30))
                return
            if path == "/api/admin/puzzles":
                self._json(200, {"ok": True, "puzzles": [{
                    "id": p["id"], "title": p["title"], "image": p.get("image", ""),
                    "surface": p["surface"], "bottom": p["bottom"],
                    "difficulty": p.get("difficulty", ""),
                    "soup": p.get("soup", ""),
                    "keys": [{"id": k["id"], "label": k.get("label", ""), "prompt": k.get("prompt", "")}
                             for k in (p.get("keys") or [])],
                    "keys_count": len(p.get("keys") or []),
                } for p in BUNDLE["puzzles"]]})
                return
            if path == "/api/admin/board":
                pid = (qs.get("puzzle_id") or [""])[0]
                if pid not in PUZZLES:
                    self._json(404, {"ok": False, "error": "puzzle not found"})
                    return
                self._json(200, {"ok": True, "puzzle_id": pid, "rows": load_board().get(pid, []),
                                 "solves": int(load_solves().get(pid) or 0)})
                return
        if self.path.startswith("/api/board"):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            pid = (qs.get("puzzle_id") or [""])[0]
            rows = load_board().get(pid, [])
            self._json(200, {"ok": True, "rows": rows,
                             "solves": int(load_solves().get(pid) or 0)})
            return
        super().do_GET()

    # 一次请求里只管一次：_body 是已经读掉的请求体，_cc_sent 是 Cache-Control 有没有发过。
    # 每个请求开头都要清（keep-alive 会拿同一个 Handler 实例连着处理好几个请求）。
    _body = None
    _cc_sent = False

    def parse_request(self):
        self._body = None
        self._cc_sent = False
        return super().parse_request()

    def do_POST(self) -> None:
        # keep-alive 下请求体必须在这次请求里读干净：`/api/stt` 这类不读 body 的分支
        # 要是留着没读的字节，它们会被当成同一条连接上下一个请求的请求行。
        # 所以进 do_POST 就先整份读掉存着，后面的 _read_body 只是取。
        self._read_body()
        if (self.headers.get("Transfer-Encoding") or "").lower().strip():
            # 分块请求体我们不解析（前端不会这么发）；这条连接用完就断，别错位
            self.close_connection = True
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"

        if path == "/api/track":
            # 只管客户端报的那一件：pv（+ uid）。ask/hint/solve/give 在这里会被
            # apply_track 滤掉 —— 那四档是服务端在各自接口里自己数的，见 bump_track()。
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            events = body.get("events") if isinstance(body.get("events"), list) else []
            if not events:
                self._json(200, {"ok": True, "skipped": "no events"})
                return
            try:
                is_new = apply_track(
                    shanghai_date(0), events[:TRACK_MAX_EVENTS], sanitize_uid(body.get("uid"))
                )
            except Exception as exc:  # 埋点坏了不能影响玩
                self._json(200, {"ok": True, "skipped": str(exc)[:120]})
                return
            self._json(200, {"ok": True, "n": len(events[:TRACK_MAX_EVENTS]), "new": is_new})
            return

        if path == "/api/admin/login":
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            code, payload = admin_login(self.client_address[0], body)
            self._json(code, payload)
            return

        if path == "/api/admin/solves/rebuild":
            # 把人数拉回「榜上还留着几个人」。写操作，所以放在 POST 这一侧 ——
            # 上一版挂到了 do_GET 里，POST 打过来只拿到 404（自己踩的）
            if not self._admin_guard():
                return
            counts = rebuild_solves()
            self._json(200, {"ok": True, "puzzles": len(counts), "solves": counts})
            return

        if path in ("/api/admin/board/delete", "/api/admin/board/clear"):
            if not self._admin_guard():
                return
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            pid = str(body.get("puzzle_id") or "").strip()
            if pid not in PUZZLES:
                self._json(404, {"ok": False, "error": "puzzle not found"})
                return
            with _stats_lock:
                board = load_board()
                rows = board.get(pid, [])
                if path.endswith("/delete"):
                    target = str(body.get("id") or "").strip()
                    kept = [r for r in rows if r.get("id") != target]
                    if len(kept) == len(rows):
                        self._json(404, {"ok": False, "error": "row not found"})
                        return
                    board[pid] = kept
                    save_board(board)
                    self._json(200, {"ok": True, "removed": len(rows) - len(kept), "rows": kept})
                    return
                board[pid] = []
                save_board(board)
                self._json(200, {"ok": True, "removed": len(rows), "rows": []})
                return

        if path == "/api/ask":
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            pid = (body.get("puzzle_id") or "").strip()
            question = (body.get("question") or "").strip()
            history = body.get("history") or []
            unlocked = body.get("unlocked") or []
            puzzle = PUZZLES.get(pid)
            if not puzzle:
                self._json(404, {"ok": False, "error": "puzzle not found"})
                return
            if not question:
                self._json(400, {"ok": False, "error": "empty question"})
                return
            if len(question) > 400:
                self._json(400, {"ok": False, "error": "question too long"})
                return
            # 校验过了就是一问，先记账再判题：判题挂了/超时也是玩家真问了，
            # 后台的「提问」该记这一笔（结案那一档另算，见下面 solved）。
            bump_track("ask", pid)
            try:
                result = judge(
                    puzzle,
                    question,
                    history if isinstance(history, list) else [],
                    unlocked if isinstance(unlocked, list) else [],
                )
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", errors="replace")[:400]
                self._json(502, {"ok": False, "error": f"typesafe {e.code}", "detail": detail})
                return
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
                return
            if result.get("solved"):
                bump_track("solve", pid)
            self._json(200, result)
            return

        if self.path.rstrip("/") == "/api/giveup":
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            puzzle = PUZZLES.get((body.get("puzzle_id") or "").strip())
            if not puzzle:
                self._json(404, {"ok": False, "error": "puzzle not found"})
                return
            bump_track("give", puzzle["id"])
            self._json(
                200,
                {"ok": True, "bottom": puzzle["bottom"], "title": puzzle["title"]},
            )
            return

        if self.path.rstrip("/") == "/api/stt":
            # 识别已在浏览器端完成，这里留个明确的墓碑，
            # 免得旧前端还往这儿传音频，只拿到一个没头没尾的 404。
            self._json(410, {"ok": False, "error": "stt moved to browser SpeechRecognition"})
            return

        if self.path.rstrip("/") == "/api/refine":
            # 听写润色已拆，与线上同一条墓碑（见 functions/api/[[path]].js 的「模型分流」）
            self._json(410, {"ok": False, "error": "refine removed: 听写原句直接进输入框", "text": ""})
            return

        if self.path.rstrip("/") == "/api/score":
            # 先把人数表准备好（缺了就按现有榜回填一次）——**必须在写榜之前**：
            # 回填看到的是「还没算上这位新玩家」的榜，之后再 +1 才是准确的。
            # 上一版把回填留在 bump_solves 里（榜已经改了），于是新玩家被算两次。
            load_solves()
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            pid = (body.get("puzzle_id") or "").strip()
            if pid not in PUZZLES:
                self._json(404, {"ok": False, "error": "puzzle not found"})
                return
            rows, is_new = upsert_score(
                pid,
                (body.get("id") or "").strip() or "anon",
                body.get("name") or "夜馆",
                body.get("asks") or 1,
                body.get("ms") or 1,
                bool(body.get("used_hint")),
            )
            self._json(200, {"ok": True, "rows": rows,
                             "solves": bump_solves(pid, is_new),
                             "first": is_new})
            return

        if self.path.rstrip("/") == "/api/hint":
            try:
                body = self._read_json()
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            puzzle = PUZZLES.get((body.get("puzzle_id") or "").strip())
            if not puzzle:
                self._json(404, {"ok": False, "error": "puzzle not found"})
                return
            bump_track("hint", puzzle["id"])
            history = body.get("history") or []
            unlocked = body.get("unlocked") or []
            prev = body.get("prev") or ""
            hint, model = make_hint(
                puzzle,
                history if isinstance(history, list) else [],
                unlocked if isinstance(unlocked, list) else [],
                prev if isinstance(prev, str) else "",
            )
            # model 跟线上对齐：实际用了链里哪个模型就报哪个，兜底时是空串
            self._json(200, {"ok": True, "hint": hint, "model": model})
            return

        self._json(404, {"ok": False, "error": "not found"})


class Server(ThreadingHTTPServer):
    """默认 request_queue_size 是 5 —— 一页要并发打进来四十来个请求，
    握手排满之后多的连接会被系统丢掉（表现为「刷新一下有几张封面是空的」）。
    开大一点，便宜且没有副作用。"""
    request_queue_size = 128


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    host = os.environ.get("HOST", "0.0.0.0")
    httpd = Server((host, port), Handler)
    # flush=True：这几行是「起没起来、密钥读到没」的唯一线索，
    # 输出重定向到文件时（后台起服务）不加它就一个字都看不到
    print(f"turtle-soup demo http://{host}:{port}/", flush=True)
    print(f"typesafe key loaded: {bool(TYPESAFE_KEY)}  judge model: {TYPESAFE_MODEL}", flush=True)
    print(f"hint: Workers AI（免费额度）{HINT_MODELS[0]} 可用={cf_ai_available()}", flush=True)
    print(f"http: {Handler.protocol_version} keep-alive · 文本类 gzip · backlog {Server.request_queue_size}", flush=True)
    print("stt: browser-side SpeechRecognition (no server model)", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
