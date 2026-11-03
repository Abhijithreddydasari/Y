"""Live check of H8 pointing (paid calls): does the ring land on the learner's wrong line?

Writes learner-style ink (jittered single-stroke glyphs, one freedraw element per pen stroke) for a
short worked problem with one planted error, renders the focus crop the way the board exports it
(white, 24 px padding, 2x), and asks "Is my working right?" through the real turn route. For each
turn's first `point` it reports: the reported line, whether the raw 0-1000 point fell in the wrong
line's box, and whether the snapped ring covers that line and no other.
Usage (from api): .venv\Scripts\python.exe scripts\live_pointing.py [turns] [--no-point]
`--no-point` is the same-time baseline: the same crops with `point` left out of the schema.
"""
from __future__ import annotations

import json
import math
import random
import statistics
import sys
import tempfile
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from learning.board_contracts import Edit, EditBatch, Element  # noqa: E402
from learning.board_router import router as board_router  # noqa: E402
from learning.board_storage import BoardStore  # noqa: E402
from learning.router import COOKIE, get_store, router  # noqa: E402
from learning.storage import CaptureStore, make_engine  # noqa: E402
from learning.tutor_router import router as tutor_router  # noqa: E402
from live_memory import turn  # noqa: E402

H = 40  # letter height in board px, about handwriting size at 100% zoom
PAD, SCALE = 24, 2

_O = [(0.3 + 0.27 * math.cos(t / 12 * 2 * math.pi), 0.5 + 0.48 * math.sin(t / 12 * 2 * math.pi)) for t in range(13)]
GLYPHS: dict[str, list[list[tuple[float, float]]]] = {
    "0": [_O],
    "1": [[(0.25, 0.15), (0.38, 0), (0.38, 1)]],
    "2": [[(0.05, 0.25), (0.2, 0.02), (0.45, 0.02), (0.55, 0.25), (0.45, 0.5), (0.05, 1), (0.6, 1)]],
    "3": [[(0.05, 0.1), (0.3, 0), (0.55, 0.15), (0.5, 0.4), (0.25, 0.5), (0.55, 0.6), (0.58, 0.85), (0.3, 1), (0.03, 0.9)]],
    "4": [[(0.45, 1), (0.45, 0), (0.02, 0.7), (0.6, 0.7)]],
    "5": [[(0.55, 0), (0.1, 0), (0.07, 0.45), (0.4, 0.4), (0.58, 0.65), (0.45, 0.95), (0.05, 0.92)]],
    "6": [[(0.5, 0.05), (0.2, 0.25), (0.05, 0.65), (0.2, 0.98), (0.5, 0.9), (0.55, 0.62), (0.3, 0.5), (0.08, 0.65)]],
    "7": [[(0.02, 0), (0.6, 0), (0.25, 1)]],
    "8": [[(0.3, 0.5), (0.05, 0.25), (0.3, 0), (0.55, 0.25), (0.3, 0.5), (0.02, 0.75), (0.3, 1), (0.58, 0.75), (0.3, 0.5)]],
    "9": [[(0.55, 0.35), (0.3, 0.5), (0.05, 0.3), (0.25, 0.02), (0.55, 0.15), (0.55, 0.5), (0.45, 1)]],
    "x": [[(0.02, 0.38), (0.5, 1)], [(0.5, 0.38), (0.02, 1)]],
    "+": [[(0.3, 0.3), (0.3, 0.88)], [(0.02, 0.6), (0.58, 0.6)]],
    "-": [[(0.05, 0.62), (0.55, 0.62)]],
    "=": [[(0.05, 0.48), (0.55, 0.48)], [(0.05, 0.74), (0.55, 0.74)]],
    "/": [[(0.55, 0), (0.05, 1)]],
}

# One planted error each; `wrong` is the 1-based line where the working first goes wrong.
PROBLEMS = [
    {"lines": ["3x + 5 = 20", "3x = 25", "x = 25/3"], "wrong": 2},
    {"lines": ["2x - 4 = 10", "2x = 6", "x = 3"], "wrong": 2},
    {"lines": ["5x + 2 = 17", "5x = 15", "x = 5"], "wrong": 3},
    {"lines": ["7 + 3x = 22", "3x = 15", "x = 15/3", "x = 6"], "wrong": 4},
]


def write(lines: list[str], rng: random.Random, left=120.0, top=140.0):
    """Freedraw strokes for the text, plus each line's box. Every pen stroke is its own element."""
    strokes, boxes = [], []
    for row, text in enumerate(lines):
        x, base = left + rng.uniform(-6, 6), top + row * 1.9 * H + rng.uniform(-4, 4)
        slope, start = rng.uniform(-0.03, 0.03), x
        line_strokes = []
        for ch in text:
            if ch == " ":
                x += 0.45 * H + rng.uniform(-3, 3)
                continue
            size = H * rng.uniform(0.92, 1.08)
            y0 = base + slope * (x - start)
            for path in GLYPHS[ch]:
                pts = []
                for (ax, ay), (bx, by) in zip(path, path[1:]):
                    for t in range(4):  # densify so the stroke wobbles like a pen line
                        u = t / 4
                        pts.append((x + (ax + (bx - ax) * u) * size + rng.gauss(0, 0.45),
                                    y0 + (ay + (by - ay) * u) * size + rng.gauss(0, 0.45)))
                pts.append((x + path[-1][0] * size, y0 + path[-1][1] * size))
                line_strokes.append(pts)
            x += 0.72 * size + rng.uniform(-2, 4)
        strokes += line_strokes
        xs = [p[0] for s in line_strokes for p in s]
        ys = [p[1] for s in line_strokes for p in s]
        boxes.append({"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)})
    return strokes, boxes


def elements(strokes) -> list[Element]:
    out = []
    for i, pts in enumerate(strokes):
        x0, y0 = min(p[0] for p in pts), min(p[1] for p in pts)
        out.append(Element(id=f"ink{i}", type="freedraw", x=x0, y=y0, width=max(p[0] for p in pts) - x0,
                           height=max(p[1] for p in pts) - y0, points=[[p[0] - x0, p[1] - y0] for p in pts],
                           strokeColor="#1e1e1e", strokeWidth=2))
    return out


def crop_image(strokes) -> tuple[bytes, dict]:
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    bounds = {"x": min(xs) - PAD, "y": min(ys) - PAD, "w": max(xs) - min(xs) + 2 * PAD, "h": max(ys) - min(ys) + 2 * PAD}
    image = Image.new("RGB", (round(bounds["w"] * SCALE), round(bounds["h"] * SCALE)), "white")
    draw = ImageDraw.Draw(image)
    for pts in strokes:
        draw.line([((p[0] - bounds["x"]) * SCALE, (p[1] - bounds["y"]) * SCALE) for p in pts], fill="#1e1e1e",
                  width=2 * SCALE, joint="curve")
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue(), bounds


def inside(point, box, pad=10) -> bool:
    return box["x"] - pad <= point["x"] <= box["x"] + box["w"] + pad and box["y"] - pad <= point["y"] <= box["y"] + box["h"] + pad


def covers(at, box) -> bool:
    return at["x"] <= box["x"] and at["y"] <= box["y"] and at["x"] + at["w"] >= box["x"] + box["w"] and at["y"] + at["h"] >= box["y"] + box["h"]


def main(turns: int) -> None:
    folder = tempfile.mkdtemp()
    capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'live.db').as_posix()}"))
    capture.initialize()
    boards = BoardStore(capture)
    app = FastAPI()
    for r in (router, board_router, tutor_router):
        app.include_router(r)
    app.dependency_overrides[get_store] = lambda: capture
    print("LIVE, paid calls: tutor (Muse Spark 1.3, minimal) reading a learner-ink crop")
    rows, rng = [], random.Random(8)
    with TestClient(app) as client:
        for n in range(turns):
            problem = PROBLEMS[n % len(PROBLEMS)]
            token = capture.issue_identity()
            owner = capture.owner_for_token(token)
            client.cookies.set(COOKIE, token)
            sid = uuid4()
            capture.create_session(owner, sid)
            strokes, boxes = write(problem["lines"], rng)
            ink = elements(strokes)
            boards.apply(owner, sid, EditBatch(operation_id=uuid4(), expected_revision=0,
                                               edits=[Edit(element=e, actor="human") for e in ink]))
            png, bounds = crop_image(strokes)
            asset = boards.put_asset(owner, sid, png)["hash"]
            board = {"request_id": str(uuid4()), "revision": 1, "viewport": {"x": 0, "y": 0, "w": 1400, "h": 1000},
                     "crops": [{"asset_hash": asset, "bounds": bounds, "element_ids": [e.id for e in ink], "purpose": "initial"}]}
            got, ms = turn(client, sid, kind="question", text="Is my working right?", board=board)
            moves = [v["move"] for k, v in got if k == "move"]
            done = next((v for k, v in got if k == "done"), {})
            points = [m for m in moves if m["type"] == "point"]
            wrong = boxes[problem["wrong"] - 1]
            row = {"turn": n, "problem": problem["lines"][0], "wrong": problem["wrong"], "points": len(points),
                   "first_move_ms": (done.get("timing") or {}).get("first_move_ms"), "total_ms": round(ms),
                   "dropped": done.get("dropped")}
            if points:
                p = points[0]
                others = [b for i, b in enumerate(boxes) if i != problem["wrong"] - 1]
                row.update(line=p["line"], label=p["label"], snap=p["snap"], line_ok=p["line"] == problem["wrong"],
                           raw_hit=inside(p["raw"], wrong),
                           ring_hit=covers(p["at"], wrong) and not any(p["at"]["y"] <= b["y"] + b["h"] / 2 <= p["at"]["y"] + p["at"]["h"] for b in others))
            rows.append(row)
            print(json.dumps(row))
    pointed = [r for r in rows if r["points"]]
    firsts = [r["first_move_ms"] for r in rows if r["first_move_ms"]]
    print(f"\nturns {len(rows)}, with a point {len(pointed)}")
    if pointed:
        print(f"reported line right {sum(r['line_ok'] for r in pointed)}/{len(pointed)}, raw point in the wrong line's box "
              f"{sum(r['raw_hit'] for r in pointed)}/{len(pointed)}, snapped ring on it {sum(r['ring_hit'] for r in pointed)}/{len(pointed)}")
    if firsts:
        print(f"first move p50 {statistics.median(firsts):.0f} ms, max {max(firsts):.0f} ms")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--no-point" in sys.argv:
        import learning.tutor_provider as provider
        provider._FORMAT = provider._FORMAT_NO_INK
        print("BASELINE: point left out of the schema")
    main(int(args[0]) if args else 12)
