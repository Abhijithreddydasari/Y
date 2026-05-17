"""Smoke-test the [draw_part] primitive on the 5 subject prompts.

Sends a synthetic 'whiteboard' PNG for each of the 5 subjects (math /
physics / chemistry / biology / cs) to the running /lesson endpoint, parses
the SSE stream, and dumps:
  - one .lesson.txt file with the full ordered list of primitives + tokens
  - one .svg file per [draw_part] block, joined into the diagram session

Useful for eyeball QA: open `api/scripts/smoke_out/*.svg` in a browser to
see what the model is producing without running the frontend.

Run after `uvicorn main:app --reload` is up (port 8000):
    .\\.venv\\Scripts\\python.exe scripts\\smoke_drawpart.py
"""
from __future__ import annotations

import io
import json
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path(__file__).resolve().parent / "smoke_out"


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _img(width: int, height: int, header: str, lines: list[tuple[str, str]]) -> bytes:
    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), header, fill="#222", font=_font(28))
    d.line([(40, 75), (40 + min(280, len(header) * 16), 75)], fill="#222", width=2)
    y = 130
    for line, color in lines:
        d.text((80, y), line, fill=color, font=_font(34))
        y += 60
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def math_pythagoras_png() -> bytes:
    return _img(900, 500, "Geometry", [
        ("right triangle", "#222"),
        ("legs 3 and 4", "#222"),
        ("hypotenuse = ?", "#c00"),
    ])


def physics_inclined_png() -> bytes:
    img = Image.new("RGB", (900, 500), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Physics", fill="#222", font=_font(28))
    d.line([(40, 75), (200, 75)], fill="#222", width=2)
    d.line([(80, 350), (520, 350)], fill="#222", width=3)
    d.line([(80, 350), (80, 180)], fill="#222", width=3)
    d.polygon([(150, 220), (220, 220), (240, 250), (170, 250)], outline="#222", width=3)
    d.text((250, 350), "30 deg incline", fill="#222", font=_font(24))
    d.text((570, 250), "m = 5 kg", fill="#222", font=_font(28))
    d.text((570, 320), "frictionless", fill="#222", font=_font(28))
    d.text((570, 390), "a = ?", fill="#c00", font=_font(34))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def chem_benzene_png() -> bytes:
    return _img(900, 400, "Chemistry", [
        ("Draw the structure of benzene?", "#222"),
        ("C6H6", "#222"),
        ("structure = ?", "#c00"),
    ])


def bio_cell_png() -> bytes:
    return _img(900, 400, "Biology", [
        ("Label the parts of an", "#222"),
        ("animal cell?", "#222"),
        ("parts = ?", "#c00"),
    ])


def cs_dfs_png() -> bytes:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Algorithms", fill="#222", font=_font(28))
    d.line([(40, 75), (220, 75)], fill="#222", width=2)
    nodes = {"A": (450, 140), "B": (300, 260), "C": (600, 260), "D": (200, 380), "E": (400, 380)}
    for name, (x, y) in nodes.items():
        d.ellipse([(x - 30, y - 30), (x + 30, y + 30)], outline="#222", width=2)
        d.text((x - 8, y - 14), name, fill="#222", font=_font(28))
    edges = [("A", "B"), ("A", "C"), ("B", "D"), ("B", "E")]
    for a, b in edges:
        d.line([nodes[a], nodes[b]], fill="#222", width=2)
    d.text((40, 470), "DFS visit order = ?", fill="#c00", font=_font(34))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _wrap_outer_svg(parts: list[dict], view_box: str) -> str:
    inner = "\n".join(p["svg"] for p in parts)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" '
        f'preserveAspectRatio="xMidYMid meet" style="background:#fff">'
        f"{inner}</svg>"
    )


def run(label: str, png: bytes) -> tuple[bool, dict]:
    """Returns (ok, stats). ok = renderable diagram OR pure-text lesson with no errors."""
    files = {"image": ("canvas.png", png, "image/png")}
    t0 = time.time()
    primitives: list[dict] = []
    tokens: list[str] = []
    err: str | None = None
    with httpx.Client(timeout=600.0) as c:
        with c.stream("POST", "http://127.0.0.1:8000/lesson", files=files) as r:
            if r.status_code != 200:
                return False, {"label": label, "error": f"HTTP {r.status_code}: {r.text}"}
            event = "message"
            buf: list[str] = []

            def flush() -> None:
                nonlocal event, buf, err
                if not buf:
                    return
                try:
                    payload = json.loads("\n".join(buf))
                except json.JSONDecodeError:
                    event, buf = "message", []
                    return
                if event == "primitive":
                    primitives.append(payload)
                elif event == "token":
                    tokens.append(payload.get("text", ""))
                elif event == "error":
                    err = payload.get("message", "<unknown>")
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
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Dump full lesson transcript.
    transcript = OUT_DIR / f"{label}.lesson.txt"
    with transcript.open("w", encoding="utf-8") as fh:
        fh.write(f"# {label}  ({elapsed:.1f}s)\n\n")
        for p in primitives:
            fh.write(f"[{p['tag']}: {json.dumps(p['args'])}]\n")
        fh.write("\n--- tokens ---\n")
        fh.write("".join(tokens))

    # Group consecutive draw_parts by viewBox (each session = one diagram).
    sessions: list[dict] = []
    current: dict | None = None
    for p in primitives:
        if p["tag"] != "draw_part":
            current = None
            continue
        vb = str(p["args"].get("viewBox", "0 0 400 300"))
        if current is None or current["viewBox"] != vb:
            current = {"viewBox": vb, "parts": []}
            sessions.append(current)
        current["parts"].append(p["args"])

    for i, s in enumerate(sessions):
        outer = _wrap_outer_svg(s["parts"], s["viewBox"])
        (OUT_DIR / f"{label}.diagram_{i}.svg").write_text(outer, encoding="utf-8")

    n_draw_parts = sum(1 for p in primitives if p["tag"] == "draw_part")
    n_diagrams = len(sessions)
    ok = err is None and len(primitives) > 0
    status = "FAIL" if not ok else "OK"
    print(
        f"  [{status}] {label}: {len(primitives)} primitives ({n_draw_parts} draw_part across "
        f"{n_diagrams} diagrams), {len(tokens)} token chunks, {elapsed:.1f}s"
        + (f", err={err}" if err else "")
    )
    return ok, {
        "label": label,
        "elapsed": elapsed,
        "n_primitives": len(primitives),
        "n_draw_parts": n_draw_parts,
        "n_diagrams": n_diagrams,
        "ok": ok,
        "error": err,
    }


def main() -> int:
    cases = [
        ("math_pythagoras", math_pythagoras_png),
        ("physics_inclined", physics_inclined_png),
        ("chem_benzene", chem_benzene_png),
        ("bio_cell", bio_cell_png),
        ("cs_dfs", cs_dfs_png),
    ]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    for label, gen in cases:
        print(f"[demo] {label}")
        ok, stats = run(label, gen())
        results.append(stats)
    print()
    n_ok = sum(1 for r in results if r["ok"])
    n_with_drawpart = sum(1 for r in results if r.get("n_draw_parts", 0) > 0)
    print(f"Renderable lessons: {n_ok}/5  |  Lessons with [draw_part]: {n_with_drawpart}/5")
    print(f"Output: {OUT_DIR}")
    return 0 if n_ok == 5 else 1


if __name__ == "__main__":
    sys.exit(main())
