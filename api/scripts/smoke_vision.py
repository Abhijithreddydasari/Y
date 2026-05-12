"""One-shot smoke test for the multimodal Gemma 4 setup.

Run from the api/ folder:
    .\.venv\Scripts\python.exe scripts\smoke_vision.py

If MODEL_NAME / OLLAMA_HOST are set in the environment they will be honored;
otherwise the defaults (gemma4:e4b, http://localhost:11434) are used.
"""
from __future__ import annotations

import io
import os
import sys
import time

import ollama
from PIL import Image, ImageDraw


def make_test_png() -> bytes:
    img = Image.new("RGB", (224, 224), "white")
    draw = ImageDraw.Draw(img)
    draw.ellipse([62, 62, 162, 162], outline="black", width=4)
    draw.text((90, 100), "HELLO ?", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> int:
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    model = os.environ.get("MODEL_NAME", "gemma4:e4b")
    print(f"[env] host={host}  model={model}")

    client = ollama.Client(host=host)

    print("[1/3] Ping Ollama list endpoint...")
    t0 = time.time()
    try:
        models = client.list()
    except Exception as exc:
        print(f"FAILED: {exc}")
        return 1
    names = [m.model for m in getattr(models, "models", []) or []] or [
        m.get("name") for m in (models.get("models", []) if isinstance(models, dict) else [])
    ]
    print(f"      ok in {time.time()-t0:.2f}s; installed models: {names}")

    if not any((model.split(':')[0] in (n or '')) for n in names):
        print(f"WARN: '{model}' not in installed models. Pull it with: ollama pull {model}")

    print(f"[2/3] Send PNG to {model}...")
    png = make_test_png()
    t0 = time.time()
    try:
        resp = client.generate(
            model=model,
            prompt="Describe this image in one short sentence.",
            images=[png],
            stream=False,
            options={"num_predict": 60, "temperature": 0.2},
        )
    except Exception as exc:
        print(f"FAILED: {exc}")
        return 2
    text = getattr(resp, "response", None) or (resp.get("response") if isinstance(resp, dict) else "")
    print(f"      generated in {time.time()-t0:.2f}s")
    print(f"      response: {text!r}")

    print("[3/3] Streamed call (first 5 chunks)...")
    t0 = time.time()
    try:
        i = 0
        for chunk in client.generate(
            model=model,
            prompt="Reply with exactly: ok",
            stream=True,
            options={"num_predict": 8, "temperature": 0.0},
        ):
            payload = chunk.get("response", "") if isinstance(chunk, dict) else getattr(chunk, "response", "")
            print(f"      chunk[{i}]: {payload!r}")
            i += 1
            if i >= 5 or (chunk.get("done") if isinstance(chunk, dict) else getattr(chunk, "done", False)):
                break
    except Exception as exc:
        print(f"FAILED: {exc}")
        return 3
    print(f"      stream ok in {time.time()-t0:.2f}s")

    print("\nALL OK. Multimodal + streaming work.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
