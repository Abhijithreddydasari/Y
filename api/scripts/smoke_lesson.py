"""End-to-end smoke test of the /lesson SSE endpoint.

Generates a synthetic 'whiteboard' PNG with a STEM question on it, POSTs it to
the running FastAPI server, and prints every parsed event so we can see what
the model produced. Useful for tuning the system prompt without spinning up
the browser.

Run from the api/ folder with the dev server already up:
    .\.venv\Scripts\python.exe scripts\smoke_lesson.py
"""
from __future__ import annotations

import io
import json
import sys
import time

import httpx
from PIL import Image, ImageDraw, ImageFont


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def make_whiteboard_png() -> bytes:
    """Synthetic 'student wrote on the whiteboard' image."""
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    title = _font(28)
    body = _font(36)

    d.text((40, 30), "Physics homework", fill="#222", font=title)
    d.line([(40, 75), (300, 75)], fill="#222", width=2)

    d.text((80, 140), "F = m * a", fill="#222", font=body)
    d.text((80, 210), "m = 2 kg", fill="#222", font=body)
    d.text((80, 280), "F = 10 N", fill="#222", font=body)
    d.text((80, 350), "a = ?", fill="#c00", font=body)

    d.rectangle([(500, 130), (820, 410)], outline="#888", width=2)
    d.text((520, 150), "(work area)", fill="#888", font=title)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> int:
    png = make_whiteboard_png()
    print(f"[png] {len(png)} bytes")

    files = {"image": ("canvas.png", png, "image/png")}
    print("[POST] http://127.0.0.1:8000/lesson")
    t0 = time.time()
    primitives: list[dict] = []
    tokens: list[str] = []
    saw_error = False

    with httpx.Client(timeout=180.0) as client:
        with client.stream("POST", "http://127.0.0.1:8000/lesson", files=files) as r:
            if r.status_code != 200:
                print(f"HTTP {r.status_code}: {r.text}")
                return 1

            event = "message"
            data_lines: list[str] = []

            def flush() -> None:
                nonlocal event, data_lines, saw_error
                if not data_lines:
                    return
                raw = "\n".join(data_lines)
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    print(f"  ! malformed data: {raw!r}")
                    event, data_lines = "message", []
                    return
                if event == "token":
                    text = payload.get("text", "")
                    tokens.append(text)
                    print(f"  [token] {text!r}")
                elif event == "primitive":
                    primitives.append(payload)
                    print(f"  [prim]  {payload}")
                elif event == "done":
                    print(f"  [done]  {payload}")
                elif event == "error":
                    saw_error = True
                    print(f"  [ERR]   {payload}")
                else:
                    print(f"  [{event}] {payload}")
                event, data_lines = "message", []

            for line in r.iter_lines():
                if line == "":
                    flush()
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].strip())
            flush()

    elapsed = time.time() - t0
    print()
    print(f"[stats] {len(tokens)} tokens, {len(primitives)} primitives, {elapsed:.1f}s")
    print(f"[stats] error event: {saw_error}")
    if primitives:
        names = [p.get("tag") for p in primitives]
        print(f"[stats] primitive types: {names}")
    return 0 if (primitives and not saw_error) else 2


if __name__ == "__main__":
    sys.exit(main())
