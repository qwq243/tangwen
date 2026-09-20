"""把 web/images 下的 PNG 转成同名 .webp（同尺寸，质量可调）。
已存在且比源文件新的就跳过。用法: python make_webp.py [--q 80] [文件名...]
"""
import sys
from pathlib import Path

from PIL import Image

WEB = Path(__file__).resolve().parent / "web" / "images"

QUALITY = 80
args = sys.argv[1:]
if args and args[0] == "--q":
    QUALITY = int(args[1])
    args = args[2:]

targets = sorted(WEB.glob("*.png"))
if args:
    wanted = set(args)
    targets = [p for p in targets if p.name in wanted]

total_in = total_out = 0
for src in targets:
    dst = src.with_suffix(".webp")
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        print("skip", src.name)
        continue
    im = Image.open(src)
    im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
    im.save(dst, "WEBP", quality=QUALITY, method=6)
    a, b = src.stat().st_size, dst.stat().st_size
    total_in += a
    total_out += b
    print(f"{src.name:28s} {a/1024:8.0f}KB -> {b/1024:7.0f}KB  ({b/a*100:4.1f}%)")

if total_in:
    print(f"\n合计 {total_in/1048576:.1f}MB -> {total_out/1048576:.1f}MB  ({total_out/total_in*100:.1f}%)")
