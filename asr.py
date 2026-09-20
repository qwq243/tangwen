"""Local Chinese ASR in the same k2-fsa family as Xime (zipformer / sherpa-onnx).

Xime Android uses on-device zipformer2. The Windows repo (winxime) is an IME,
not STT, so this demo runs sherpa-onnx zipformer locally instead.

识别器是**常驻单例**：构建一次要读三个 onnx（约 800ms），每次请求重建会把
一次听写拖到 1 秒以上。现在一次构建、长期复用，解码本身只要几十毫秒。
"""

from __future__ import annotations

import os
import tarfile
import threading
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models" / "zipformer-zh-14m"
URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2"
)

_REC = None
_REC_LOCK = threading.Lock()
_DECODE_LOCK = threading.Lock()
LOAD_MS = 0.0

# 低于这个 RMS 就当没说话——省掉一次无谓的解码
SILENCE_RMS = 0.0035


def ensure_model() -> Path:
    if (MODEL_DIR / "tokens.txt").is_file():
        return MODEL_DIR
    MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    archive = MODEL_DIR.parent / "zipformer-zh-14m.tar.bz2"
    if not archive.is_file():
        print("downloading zipformer-zh-14M...", flush=True)
        urllib.request.urlretrieve(URL, archive)
    print("extracting zipformer...", flush=True)
    tmp = MODEL_DIR.parent / "_extract"
    tmp.mkdir(exist_ok=True)
    with tarfile.open(archive, "r:bz2") as tf:
        tf.extractall(tmp)
    extracted = next(tmp.glob("sherpa-onnx-streaming-zipformer-zh*"))
    if not MODEL_DIR.exists():
        extracted.rename(MODEL_DIR)
    return MODEL_DIR


def _pick(d: Path, kind: str) -> str:
    int8 = sorted(d.glob(f"{kind}*.int8.onnx"))
    if int8:
        return str(int8[0])
    return str(sorted(d.glob(f"{kind}*.onnx"))[0])


def recognizer():
    """构建一次就留着。并发调用由 _REC_LOCK 保证只建一个。"""
    global _REC, LOAD_MS
    if _REC is not None:
        return _REC
    with _REC_LOCK:
        if _REC is not None:
            return _REC
        import time

        import sherpa_onnx

        d = ensure_model()
        threads = max(1, min(4, os.cpu_count() or 2))
        t0 = time.perf_counter()
        _REC = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(d / "tokens.txt"),
            encoder=_pick(d, "encoder"),
            decoder=_pick(d, "decoder"),
            joiner=_pick(d, "joiner"),
            num_threads=threads,
            sample_rate=16000,
            feature_dim=80,
            decoding_method="greedy_search",
        )
        LOAD_MS = (time.perf_counter() - t0) * 1000
        print(f"[asr] recognizer ready in {LOAD_MS:.0f} ms (threads={threads})", flush=True)
    return _REC


def warmup() -> bool:
    """服务启动时后台预热，免得第一位玩家吃冷启动。"""
    try:
        recognizer()
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[asr] warmup failed: {e}", flush=True)
        return False


def _load_wav(path: str):
    import numpy as np

    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        n = wf.getnchannels()
        sw = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if sw == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    else:
        samples = np.frombuffer(raw, dtype=np.uint8).astype("float32")
        samples = (samples - 128.0) / 128.0
    if n > 1:
        samples = samples.reshape(-1, n).mean(axis=1)
    return sr, samples


def transcribe(wav_path: str) -> str:
    import numpy as np

    sr, samples = _load_wav(wav_path)
    if samples.size == 0:
        return ""
    rms = float(np.sqrt(np.mean(np.square(samples))))
    if rms < SILENCE_RMS:
        return ""
    rec = recognizer()
    with _DECODE_LOCK:
        stream = rec.create_stream()
        stream.accept_waveform(sr, samples)
        stream.accept_waveform(sr, [0.0] * int(sr * 0.4))
        stream.input_finished()
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        return (rec.get_result(stream) or "").strip()


if __name__ == "__main__":
    import sys
    import time

    if sys.argv[1:] == ["download"]:
        print(ensure_model())
    else:
        warmup()
        for arg in sys.argv[1:]:
            t0 = time.perf_counter()
            print(f"{arg}: {transcribe(arg)!r}  ({(time.perf_counter()-t0)*1000:.0f} ms)")
