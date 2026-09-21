#!/usr/bin/env python3
"""打部署包：只收运行期需要的文件，先校验引用完整性再压。

用法：python pack.py

剔除：models/（148MB，已停用的 ASR 模型）、tmp/、__pycache__/、asr.py、
      web/prototypes/、web/images/*debug.jpg、dist/ 自身

校验：把 index.html / styles.css / app.js / audio.js / puzzles.json 里出现的
      本地路径全部抽出来，逐个确认落在包内 —— 少一个就报错退出，不出半成品。
"""

from __future__ import annotations

import re
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
ZIP_NAME = f"tangwen-{time.strftime('%Y%m%d')}.zip"

# 运行期必需
ENTRY = [
    "server.py",
    "puzzles.json",
    "requirements.txt",
    "README.md",
    # 许可不是运行期的东西，但发布的副本里没有它就说不过去了
    "LICENSE",
    "start.cmd",
    "web/index.html",
    "web/styles.css",
    "web/app.js",
    "web/audio.js",
    "web/_headers",
    "web/admin/index.html",
    "web/admin/admin.css",
    "web/admin/admin.js",
    "wrangler.jsonc",
    "package.json",
    "functions/api/[[path]].js",
    "functions/puzzles.json",
]
IMAGE_EXT = (".png", ".webp")
LOCAL_EXT = (".png", ".webp", ".jpg", ".jpeg", ".svg", ".css", ".js", ".json")
SCAN = ("web/index.html", "web/styles.css", "web/app.js", "web/audio.js")
PATS = (
    re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)"""),
    re.compile(r"""["'`](\.?/?(?:images|prototypes)/[^"'`]+)["'`]"""),
)


def collect() -> list[str]:
    out: list[str] = []
    for rel in ENTRY:
        if not (ROOT / rel).is_file():
            sys.exit(f"[FAIL] 缺少必需文件: {rel}")
        out.append(rel)
    for f in sorted((ROOT / "web" / "images").iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXT and not f.name.endswith("debug.jpg"):
            out.append(f"web/images/{f.name}")
    return out


def referenced_assets() -> set[str]:
    """从源码里捞出所有本地资源引用（含 image-set 的多个 url() 与 JS 字符串）。

    源码里的路径都是相对 web/ 写的（`./images/x.png` / `images/x.png`），
    统一补成 `web/...` 再跟包内清单比，否则会误报一堆「缺失」。
    另外 url() 里可能是 data: 内联 SVG（含 `)` 和 `%23`），要滤掉。
    """
    found: set[str] = set()
    for rel in SCAN:
        text = (ROOT / rel).read_text(encoding="utf-8")
        for pat in PATS:
            for m in pat.finditer(text):
                u = m.group(1).strip()
                if u.startswith(("http:", "https:", "data:", "//", "#")) or "data:" in u:
                    continue
                u = u.split("?")[0].lstrip("./")
                if not u or Path(u).suffix.lower() not in LOCAL_EXT:
                    continue
                # 只收静态资源，源码自身不作校验对象；路径统一用 /，免得跟 zip 里的写法对不上
                if Path(u).suffix.lower() in (".png", ".webp", ".jpg", ".jpeg", ".svg"):
                    found.add((Path("web") / u).as_posix())
    text = (ROOT / "puzzles.json").read_text(encoding="utf-8")
    for m in re.finditer(r"""["'](images/[^"']+\.(?:png|webp|jpg))["']""", text):
        found.add((Path("web") / m.group(1)).as_posix())
    return found


def main() -> None:
    files = collect()
    packed = set(files)
    refs = referenced_assets()
    missing = sorted(a for a in refs if a not in packed)
    if missing:
        print("[FAIL] 以下被引用的资源不在包里：")
        for m in missing:
            hit = (ROOT / m).is_file()
            print(f"   {m}   （磁盘上{'有' if hit else '没有'}）")
        sys.exit(1)

    DIST.mkdir(exist_ok=True)
    target = DIST / ZIP_NAME
    by_kind: dict[str, int] = {}
    for rel in files:
        size = (ROOT / rel).stat().st_size
        kind = "webp 封面" if rel.endswith(".webp") else ("png 兜底封面" if rel.endswith(".png") else "代码 / 数据")
        by_kind[kind] = by_kind.get(kind, 0) + size
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            z.write(ROOT / rel, rel)

    print(f"引用校验通过：{len(refs)} 条引用全部在包内")
    print(f"文件数 {len(files)}  原始 {sum(by_kind.values()) / 1048576:.2f} MB")
    for k, v in sorted(by_kind.items(), key=lambda x: -x[1]):
        print(f"   {k:<12} {v / 1048576:7.2f} MB")
    print(f"→ {target}  {target.stat().st_size / 1048576:.2f} MB")


if __name__ == "__main__":
    main()
