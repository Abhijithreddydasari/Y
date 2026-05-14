"""Dump the raw byte stream of /lesson so we can see exactly what frames sse-starlette emits.

Useful for confirming the line separator (LF vs CRLF) the frontend parser must split on.
"""
from __future__ import annotations

import io
import sys

import httpx
from PIL import Image, ImageDraw


def make_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((80, 80), "F = m * a, m = 2 kg, F = 10 N, a = ?", fill="#111")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def main() -> int:
    files = {"image": ("canvas.png", make_png(), "image/png")}
    captured: list[bytes] = []
    with httpx.Client(timeout=120.0) as c:
        with c.stream("POST", "http://127.0.0.1:8000/lesson", files=files) as r:
            print("status:", r.status_code)
            print("headers:")
            for k, v in r.headers.items():
                print(f"  {k}: {v}")
            for chunk in r.iter_raw():
                captured.append(chunk)
                if sum(len(c) for c in captured) > 6000:
                    break
    blob = b"".join(captured)
    print("---raw bytes (first 2500)---")
    print(repr(blob[:2500]))
    print("---separator check---")
    print("LF-LF count :", blob.count(b"\n\n"))
    print("CRLF-CRLF c.:", blob.count(b"\r\n\r\n"))
    print("CR count    :", blob.count(b"\r"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
