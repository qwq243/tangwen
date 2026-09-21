#!/usr/bin/env python3
"""批量出封面：按 docs/design/prompts.jsonl 逐条调一个 OpenAI 兼容的生图接口。

已经存在且大于 20KB 的图会跳过，所以可以反复跑、只补缺的那几张。

只对**补卷**有用：仓库里 44 张封面已经出好了，日常开发不需要跑这个脚本。
要出图得自己准备两样，都走环境变量：

    IMAGE_BASE_URL   生图网关的 OpenAI 兼容根地址，例如 https://your-gateway/v1
    IMAGE_CLIENT     实际发请求的客户端脚本（可选）。
                     默认用内置的 urllib 直连；如果你的网关要签名 / 代理，
                     指一个自己写的脚本，它会被这样调用：
                         python <IMAGE_CLIENT> generate --base-url ... --prompt-file ... --out ...
                     接口见 README「封面」一节。

    IMAGE_MODEL      模型名，默认 gpt-image-2
    IMAGE_KEY        网关要的话就设（会以 Authorization: Bearer 发出去）

用法：
    IMAGE_BASE_URL=https://your-gateway/v1 python generate_covers.py              # 缺哪张出哪张
    IMAGE_BASE_URL=https://your-gateway/v1 python generate_covers.py dorm.png     # 只出指定几张
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JSONL = ROOT / "docs" / "design" / "prompts.jsonl"
OUT_DIR = ROOT / "web" / "images"
PROMPT_DIR = ROOT / "tmp" / "prompt-files"
BASE = os.environ.get("IMAGE_BASE_URL", "").rstrip("/")
MODEL = os.environ.get("IMAGE_MODEL", "gpt-image-2")
CLIENT = os.environ.get("IMAGE_CLIENT", "")
KEY = os.environ.get("IMAGE_KEY", "")


def gen_direct(prompt_file: Path, dest: Path) -> int:
    """内置直连：POST {BASE}/images/generations，拿回来的 url 或 b64 落盘。"""
    import base64

    payload = json.dumps({
        "model": MODEL,
        "prompt": prompt_file.read_text(encoding="utf-8"),
        "size": "1024x1024",
        "quality": "high",
        "response_format": "b64_json",
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if KEY:
        headers["Authorization"] = "Bearer " + KEY
    req = urllib.request.Request(f"{BASE}/images/generations", data=payload,
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=240) as resp:
        body = json.loads(resp.read().decode("utf-8", "replace"))
    item = ((body.get("data") or [{}])[0]) or {}
    if item.get("b64_json"):
        dest.write_bytes(base64.b64decode(item["b64_json"]))
        return 0
    if item.get("url"):
        with urllib.request.urlopen(item["url"], timeout=240) as img:
            dest.write_bytes(img.read())
        return 0
    print(f"  ? 响应里既没有 b64_json 也没有 url：{str(body)[:200]}", flush=True)
    return 1


def gen_via_client(prompt_file: Path, dest: Path) -> int:
    """走外部客户端脚本（网关要签名 / 走代理时用这个）。"""
    cmd = [
        sys.executable, CLIENT, "generate",
        "--base-url", BASE,
        "--model", MODEL,
        "--size", "1024x1024",
        "--quality", "high",
        "--response-format", "url",
        "--no-stream",
        "--transport", "urllib",
        "--convert", "png",
        "--retries", "3",
        "--timeout", "240",
        "--prompt-file", str(prompt_file),
        "--out", str(dest),
    ]
    return subprocess.run(cmd).returncode


def main() -> int:
    wanted = set(sys.argv[1:])
    if not BASE:
        sys.exit("缺 IMAGE_BASE_URL：本脚本只对补卷出封面用，要出图得先指一个生图网关。\n"
                 "    IMAGE_BASE_URL=https://your-gateway/v1 python generate_covers.py")
    if CLIENT and not Path(CLIENT).is_file():
        sys.exit(f"IMAGE_CLIENT 指的文件不存在: {CLIENT}")
    PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [json.loads(line) for line in JSONL.read_text(encoding="utf-8").splitlines() if line.strip()]
    failed = []
    for job in jobs:
        name = job["out"]
        if wanted and name not in wanted:
            continue
        dest = OUT_DIR / name
        if dest.exists() and dest.stat().st_size > 20_000:
            print("skip", name, dest.stat().st_size)
            continue
        prompt_file = PROMPT_DIR / f"{dest.stem}.txt"
        prompt_file.write_text(job["prompt"], encoding="utf-8")
        print("GEN", name, flush=True)
        try:
            rc = gen_via_client(prompt_file, dest) if CLIENT else gen_direct(prompt_file, dest)
        except (urllib.error.HTTPError, OSError) as e:
            detail = e.read().decode("utf-8", "replace")[:200] if isinstance(e, urllib.error.HTTPError) else e
            print(f"  ! {detail}", flush=True)
            rc = 1
        if rc != 0 or not dest.exists():
            failed.append(name)
            print("FAIL", name, flush=True)
        else:
            print("OK", name, dest.stat().st_size, flush=True)
    if failed:
        print("failed:", ", ".join(failed))
        print("出图之后记得跑一遍 make_webp.py 生成 webp 兜底。", flush=True)
        return 1
    if shutil.which("python"):
        print("下一步：python make_webp.py", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

