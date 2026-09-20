#!/usr/bin/env python3
"""Generate missing cover stills through NewAPI. Skip files that already exist."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JSONL = ROOT / "docs" / "design" / "prompts.jsonl"
OUT_DIR = ROOT / "web" / "images"
PROMPT_DIR = ROOT / "tmp" / "prompt-files"
SCRIPT = Path.home() / ".codex" / "skills" / "newapi-imagegen" / "scripts" / "newapi_image.py"
BASE = "https://netcup-1.toapi.xyz/v1"


def main() -> int:
    wanted = set(sys.argv[1:])
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
        cmd = [
            sys.executable,
            str(SCRIPT),
            "generate",
            "--base-url",
            BASE,
            "--model",
            "gpt-image-2",
            "--size",
            "1024x1024",
            "--quality",
            "high",
            "--response-format",
            "url",
            "--no-stream",
            "--transport",
            "urllib",
            "--convert",
            "png",
            "--retries",
            "3",
            "--timeout",
            "240",
            "--prompt-file",
            str(prompt_file),
            "--out",
            str(dest),
        ]
        print("GEN", name, flush=True)
        r = subprocess.run(cmd)
        if r.returncode != 0 or not dest.exists():
            failed.append(name)
            print("FAIL", name, flush=True)
        else:
            print("OK", name, dest.stat().st_size, flush=True)
    if failed:
        print("failed:", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
