"""Where a `point` move lands on the board: crop coordinates → board, snapped to the learner's ink line.

Vision points are close but skew downward (11/18 raw hits in planning); the reported line is
reliable (18/18), so the ring goes on the ink of that line. Pure and bounded: no model calls.
"""
from __future__ import annotations

from statistics import median

PAD = 10
RAW_RING = 60
MAX_STROKES = 200
LINE_OVERLAP = 0.4
COLUMN_GAP = 3.0  # a gap this many line heights wide separates two pieces of work on one row


def _box(items: list[dict]) -> dict:
    left, top = min(b["x"] for b in items), min(b["y"] for b in items)
    right, bottom = max(b["x"] + b["w"] for b in items), max(b["y"] + b["h"] for b in items)
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


def ink_lines(boxes: list[dict]) -> list[list[dict]]:
    """Group stroke boxes into lines, top to bottom: a stroke joins the line it overlaps vertically."""
    boxes = boxes[:MAX_STROKES]
    if not boxes:
        return []
    # Letters set the lines; flat strokes (minus, equals, fraction bars) join the nearest line afterwards.
    heights = sorted(b["h"] for b in boxes)
    tall = 0.35 * heights[(3 * len(heights)) // 4]
    letters, flat = [b for b in boxes if b["h"] >= tall], [b for b in boxes if b["h"] < tall]
    lines: list[list[dict]] = []
    spans: list[list[float]] = []
    for b in sorted(letters, key=lambda b: b["y"] + b["h"] / 2):
        top, bottom = b["y"], b["y"] + b["h"]
        if spans:
            span = spans[-1]
            overlap = min(bottom, span[1]) - max(top, span[0])
            if overlap >= LINE_OVERLAP * max(1.0, min(b["h"], span[1] - span[0])):
                lines[-1].append(b)
                span[0], span[1] = min(span[0], top), max(span[1], bottom)
                continue
        lines.append([b])
        spans.append([top, bottom])
    for b in flat:
        centre = b["y"] + b["h"] / 2
        nearest = min(range(len(spans)), key=lambda i: max(spans[i][0] - centre, 0, centre - spans[i][1]))
        lines[nearest].append(b)
    return lines


def _height(line: list[dict]) -> float:
    tallest = max(b["h"] for b in line)
    # Ignore flat strokes (minus signs, bars) when judging a line's letter height.
    return max(8.0, median([b["h"] for b in line if b["h"] >= 0.25 * tallest]))


def _cluster(line: list[dict], x: float) -> list[dict]:
    """Strokes of one piece of work on the row: split at wide gaps, keep the part nearest x."""
    ordered, gap = sorted(line, key=lambda b: b["x"]), COLUMN_GAP * _height(line)
    parts, right = [[ordered[0]]], ordered[0]["x"] + ordered[0]["w"]
    for b in ordered[1:]:
        if b["x"] - right > gap:
            parts.append([])
        parts[-1].append(b)
        right = max(right, b["x"] + b["w"])

    def distance(part: list[dict]) -> float:
        box = _box(part)
        return max(box["x"] - x, 0, x - box["x"] - box["w"])
    return min(parts, key=distance)


def resolve(move: dict, crop: dict, focused: list[dict]) -> dict:
    """Board placement for a point on `crop` (the image it indexes): `at`, `raw`, `snap`, `lines`."""
    bounds = crop["bounds"]
    raw = {"x": bounds["x"] + move["x"] / 1000 * bounds["w"], "y": bounds["y"] + move["y"] / 1000 * bounds["h"]}
    ids = set(crop["element_ids"])
    boxes = [f["bounds"] for f in focused if f["id"] in ids and f["creator"] == "human" and f.get("visual", True)]
    lines = ink_lines(boxes)
    if not lines:
        half = RAW_RING / 2
        return {"at": {"x": raw["x"] - half, "y": raw["y"] - half, "w": RAW_RING, "h": RAW_RING}, "raw": raw,
                "snap": "raw", "lines": 0}
    if 1 <= move["line"] <= len(lines):
        chosen, snap = lines[move["line"] - 1], "line"
    else:
        def off(line: list[dict]) -> float:
            box = _box(line)
            return max(box["y"] - raw["y"], 0, raw["y"] - box["y"] - box["h"])
        chosen, snap = min(lines, key=off), "nearest"
    box = _box(_cluster(chosen, raw["x"]))
    at = {"x": box["x"] - PAD, "y": box["y"] - PAD, "w": box["w"] + 2 * PAD, "h": box["h"] + 2 * PAD}
    return {"at": {k: round(v, 1) for k, v in at.items()}, "raw": {k: round(v, 1) for k, v in raw.items()},
            "snap": snap, "lines": len(lines)}
