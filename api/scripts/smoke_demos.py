"""Smoke test all 5 subject demos through the running /lesson endpoint.

Generates synthetic 'whiteboard' images for math, physics, chemistry, biology,
and computer science, POSTs each to FastAPI, and reports primitive counts.

By default runs once per subject against the model_choice you pass on the
command line (default "edge"). Pass `--all-models` to fan out across edge /
edge-ft / cloud and emit a 5x3 results matrix - the standard P10 sweep.

Run with the dev server up:
    .\\.venv\\Scripts\\python.exe scripts\\smoke_demos.py
    .\\.venv\\Scripts\\python.exe scripts\\smoke_demos.py --model edge-ft
    .\\.venv\\Scripts\\python.exe scripts\\smoke_demos.py --all-models
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
from dataclasses import dataclass
from typing import Callable

import httpx
from PIL import Image, ImageDraw, ImageFont


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def math_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Geometry", fill="#222", font=_font(28))
    d.line([(40, 75), (200, 75)], fill="#222", width=2)
    d.line([(160, 280), (160, 420)], fill="#222", width=3)  # vertical leg
    d.line([(160, 420), (380, 420)], fill="#222", width=3)  # horizontal leg
    d.line([(160, 280), (380, 420)], fill="#222", width=3)  # hypotenuse
    d.text((90, 340), "3", fill="#222", font=_font(28))
    d.text((250, 430), "4", fill="#222", font=_font(28))
    d.text((280, 320), "?", fill="#c00", font=_font(40))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def physics_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Mechanics", fill="#222", font=_font(28))
    d.line([(40, 75), (220, 75)], fill="#222", width=2)
    # incline
    d.line([(120, 460), (560, 200)], fill="#222", width=3)
    d.line([(120, 460), (560, 460)], fill="#222", width=3)
    d.line([(560, 200), (560, 460)], fill="#222", width=3)
    d.text((300, 470), "30 deg", fill="#222", font=_font(24))
    # block
    d.rectangle([(360, 270), (440, 330)], outline="#222", width=3)
    d.text((375, 285), "m", fill="#222", font=_font(28))
    d.text((80, 200), "frictionless", fill="#222", font=_font(24))
    d.text((80, 240), "a = ?", fill="#c00", font=_font(34))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def chem_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Organic chem", fill="#222", font=_font(28))
    d.line([(40, 75), (240, 75)], fill="#222", width=2)
    d.text((80, 200), "Draw the structure of benzene?", fill="#222", font=_font(28))
    d.text((80, 260), "C6H6", fill="#222", font=_font(28))
    d.text((80, 330), "structure = ?", fill="#c00", font=_font(34))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def bio_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Cell biology", fill="#222", font=_font(28))
    d.line([(40, 75), (220, 75)], fill="#222", width=2)
    d.text((80, 130), "Label parts of an animal cell?", fill="#222", font=_font(28))
    # crude cell sketch
    d.ellipse([(360, 200), (760, 480)], outline="#222", width=3)
    d.ellipse([(500, 280), (620, 380)], outline="#222", width=3)
    d.text((80, 200), "?", fill="#c00", font=_font(60))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def cs_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Algorithms", fill="#222", font=_font(28))
    d.line([(40, 75), (220, 75)], fill="#222", width=2)
    d.text((80, 130), "DFS visit order on this rooted tree?", fill="#222", font=_font(28))
    # tree
    nodes = {
        "A": (480, 200),
        "B": (380, 300),
        "C": (580, 300),
        "D": (320, 420),
        "E": (440, 420),
        "F": (540, 420),
        "G": (640, 420),
    }
    edges = [("A", "B"), ("A", "C"), ("B", "D"), ("B", "E"), ("C", "F"), ("C", "G")]
    for a, b in edges:
        d.line([nodes[a], nodes[b]], fill="#222", width=2)
    for name, (x, y) in nodes.items():
        d.ellipse([(x - 24, y - 24), (x + 24, y + 24)], outline="#222", width=2)
        d.text((x - 8, y - 14), name, fill="#222", font=_font(24))
    d.text((80, 200), "?", fill="#c00", font=_font(60))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@dataclass
class Result:
    label: str
    model: str
    prim: int
    tok: int
    err: bool
    elapsed: float


def run(
    label: str,
    png: bytes,
    *,
    base: str,
    model: str,
    teacher_mode: bool = False,
    timeout: float = 300.0,
) -> Result:
    files = {"image": ("canvas.png", png, "image/png")}
    data = {
        "model_choice": model,
        "teacher_mode": "true" if teacher_mode else "false",
        "user_id": "smoke",
    }
    t0 = time.time()
    prim = tok = 0
    err = False
    with httpx.Client(timeout=timeout) as c:
        with c.stream("POST", f"{base}/lesson", files=files, data=data) as r:
            if r.status_code != 200:
                print(f"  HTTP {r.status_code}: {r.text}")
                return Result(label, model, 0, 0, True, time.time() - t0)
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
                    print(f"  ERROR ({model}/{label}): {payload}")
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
    print(f"  [{status}] {model:9s} {label:18s} {prim:>3} prim, {tok:>4} tok, {elapsed:5.1f}s")
    return Result(label, model, prim, tok, err, elapsed)


SUBJECTS: list[tuple[str, Callable[[], bytes]]] = [
    ("Math (Pythagoras)", math_png),
    ("Physics (incline)", physics_png),
    ("Chem (benzene)", chem_png),
    ("Bio (cell)", bio_png),
    ("CS (DFS tree)", cs_png),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000", help="API base URL")
    ap.add_argument("--model", default="edge", help="model_choice (edge|edge-ft|cloud)")
    ap.add_argument("--all-models", action="store_true", help="sweep edge / edge-ft / cloud")
    ap.add_argument("--teacher-mode", action="store_true")
    args = ap.parse_args()

    models = ["edge", "edge-ft", "cloud"] if args.all_models else [args.model]
    rows: list[Result] = []
    for model in models:
        print(f"[demo] model={model}")
        for label, gen in SUBJECTS:
            rows.append(run(label, gen(), base=args.base, model=model, teacher_mode=args.teacher_mode))
        print()

    # Summary matrix.
    print("=" * 64)
    print(f"{'subject':<22} | " + " | ".join(f"{m:>9}" for m in models))
    print("-" * 64)
    for label, _ in SUBJECTS:
        cells = []
        for m in models:
            r = next((x for x in rows if x.label == label and x.model == m), None)
            if r is None:
                cells.append("    -    ")
            elif r.err or r.prim == 0:
                cells.append("   FAIL  ")
            else:
                cells.append(f"{r.prim:>3}p {r.elapsed:>4.1f}s")
        print(f"{label:<22} | " + " | ".join(cells))
    print("=" * 64)

    failures = sum(1 for r in rows if r.err or r.prim == 0)
    total = len(rows)
    print(f"Passing: {total - failures}/{total}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
