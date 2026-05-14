"""Smoke test all three demo scenarios through the running /lesson endpoint.

Generates synthetic 'whiteboard' images for:
  1. Newton's 2nd law
  2. Vector addition
  3. Binary search

POSTs each to FastAPI and reports primitive counts so we can see whether the
model latches onto the few-shot examples.

Run with the dev server up:
    .\\.venv\\Scripts\\python.exe scripts\\smoke_demos.py
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


def newton_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Physics homework", fill="#222", font=_font(28))
    d.line([(40, 75), (320, 75)], fill="#222", width=2)
    d.text((80, 140), "F = m * a", fill="#222", font=_font(36))
    d.text((80, 210), "m = 2 kg", fill="#222", font=_font(36))
    d.text((80, 280), "F = 10 N", fill="#222", font=_font(36))
    d.text((80, 350), "a = ?", fill="#c00", font=_font(36))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def vector_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Vector addition", fill="#222", font=_font(28))
    d.line([(40, 75), (320, 75)], fill="#222", width=2)
    # vector u (right)
    d.line([(120, 350), (380, 350)], fill="#222", width=3)
    d.polygon([(380, 350), (368, 342), (368, 358)], fill="#222")
    d.text((230, 360), "u", fill="#222", font=_font(28))
    # vector v (up-right)
    d.line([(120, 350), (310, 200)], fill="#0a0", width=3)
    d.polygon([(310, 200), (302, 215), (318, 213)], fill="#0a0")
    d.text((200, 250), "v", fill="#0a0", font=_font(28))
    d.text((500, 250), "u + v = ?", fill="#c00", font=_font(34))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def binary_search_png() -> bytes:
    img = Image.new("RGB", (900, 500), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Algorithms", fill="#222", font=_font(28))
    d.line([(40, 75), (220, 75)], fill="#222", width=2)
    arr = [1, 3, 5, 7, 9, 11]
    x = 80
    for n in arr:
        d.rectangle([(x, 160), (x + 90, 240)], outline="#222", width=2)
        d.text((x + 30, 175), str(n), fill="#222", font=_font(28))
        x += 110
    d.text((80, 320), "find 7 ?", fill="#c00", font=_font(36))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def run(label: str, png: bytes) -> tuple[int, int, bool]:
    files = {"image": ("canvas.png", png, "image/png")}
    t0 = time.time()
    prim = tok = 0
    err = False
    with httpx.Client(timeout=300.0) as c:
        with c.stream("POST", "http://127.0.0.1:8000/lesson", files=files) as r:
            if r.status_code != 200:
                print(f"  HTTP {r.status_code}: {r.text}")
                return (0, 0, True)
            event = "message"
            buf: list[str] = []

            def flush() -> None:
                nonlocal event, buf, prim, tok, err
                if not buf:
                    return
                try:
                    payload = json.loads("\n".join(buf))
                except json.JSONDecodeError:
                    event, buf = "message", []
                    return
                if event == "primitive":
                    prim += 1
                elif event == "token":
                    tok += 1
                elif event == "error":
                    err = True
                    print(f"  ERROR: {payload}")
                event, buf = "message", []

            for line in r.iter_lines():
                if line == "":
                    flush()
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    buf.append(line[5:].strip())
            flush()
    elapsed = time.time() - t0
    status = "FAIL" if err or prim == 0 else "OK"
    print(f"  [{status}] {label}: {prim} primitives, {tok} tokens, {elapsed:.1f}s")
    return (prim, tok, err)


def main() -> int:
    results = []
    for label, gen in [
        ("Newton's 2nd law", newton_png),
        ("Vector addition", vector_png),
        ("Binary search", binary_search_png),
    ]:
        print(f"[demo] {label}")
        results.append((label, *run(label, gen())))
    print()
    ok = sum(1 for _, p, _, e in results if not e and p > 0)
    print(f"Passing demos: {ok}/3")
    return 0 if ok == 3 else 1


if __name__ == "__main__":
    sys.exit(main())
