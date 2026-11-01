"""Pure, bounded scene selection; no model calls and no pairwise spatial scans."""
from __future__ import annotations

import math
from collections import defaultdict, deque

from .board_contracts import BoardSource, ContextInput, ContextPacket, Rect
from .contracts import canonical, digest
from .packs import TASKS

MAX_CONTEXT = 24 * 1024


def bounds(e: dict) -> dict:
    x, y, w, h = e["x"], e["y"], e["width"], e["height"]
    points = e.get("points") if e["type"] in {"freedraw", "line", "arrow"} else None
    if points:
        xs, ys = zip(*[(float(p[0]), float(p[1])) for p in points])
        x, y, w, h = x + min(xs), y + min(ys), max(xs) - min(xs), max(ys) - min(ys)
    cx, cy = x + w / 2, y + h / 2
    c, s = abs(math.cos(e.get("angle", 0))), abs(math.sin(e.get("angle", 0)))
    rw, rh = abs(w) * c + abs(h) * s, abs(w) * s + abs(h) * c
    return {"x": cx - rw / 2, "y": cy - rh / 2, "w": max(1, rw), "h": max(1, rh)}


def intersects(a: dict, b: dict) -> bool:
    return a["x"] <= b["x"] + b["w"] and b["x"] <= a["x"] + a["w"] and a["y"] <= b["y"] + b["h"] and b["y"] <= a["y"] + a["h"]


def semantic(e: dict) -> dict | None:
    value = (e.get("customData") or {}).get("ySemantic")
    return value if isinstance(value, dict) else None


def visual(record: dict) -> bool:
    return record["element"]["type"] in {"freedraw", "image"} and not semantic(record["element"])


def build_context(session_id, revision: int, records: dict, regions: list, request: ContextInput) -> ContextPacket:
    live = {key: r for key, r in records.items() if not r["element"].get("isDeleted")}
    region = next((r for r in regions if r["region_id"] == str(request.region_id)), None)
    if request.selection:
        associations = {live[key].get("task_region") for key in request.selection if key in live}
        region = next((r for r in regions if len(associations) == 1 and r["region_id"] in associations), None)
    task = TASKS.get(region["task_id"]) if region else None
    area = region["bounds"] if region else request.viewport.model_dump() if request.viewport else {"x": 0, "y": 0, "w": 1400, "h": 1000}
    boxes = {key: bounds(r["element"]) for key, r in live.items()}
    groups, links = defaultdict(list), defaultdict(set)
    for key, r in live.items():
        e = r["element"]
        for group in e.get("groupIds") or []:
            groups[group].append(key)
        related = [v.get("id") for v in e.get("boundElements") or [] if isinstance(v, dict)]
        related += [e.get("containerId"), e.get("frameId")]
        for name in ("startBinding", "endBinding"):
            related.append((e.get(name) or {}).get("elementId"))
        for other in related:
            if other in live:
                links[key].add(other)
                links[other].add(key)
    selected = set(request.selection) & live.keys()
    if not request.selection:
        selected = {key for key in live if intersects(boxes[key], area)}
    initial = set(selected)
    if request.selection and selected:
        left, top = min(boxes[k]["x"] for k in selected), min(boxes[k]["y"] for k in selected)
        right, bottom = max(boxes[k]["x"] + boxes[k]["w"] for k in selected), max(boxes[k]["y"] + boxes[k]["h"] for k in selected)
        area = {"x": left, "y": top, "w": max(1, right - left), "h": max(1, bottom - top)}
    queue, seen_groups = deque(selected), set()
    while queue:
        key = queue.popleft()
        neighbors = set(links[key])
        for group in live[key]["element"].get("groupIds") or []:
            if group not in seen_groups:
                seen_groups.add(group)
                neighbors.update(groups[group])
        for other in neighbors - selected:
            selected.add(other)
            queue.append(other)
    outside = []
    if region and not request.selection:
        outside = [key for key, r in live.items() if r.get("task_region") == region["region_id"]
                   and r["creator"] == "human" and key not in selected]
    ordered = sorted(selected, key=lambda k: (k not in initial, boxes[k]["y"], boxes[k]["x"], k))
    focused = []
    for key in ordered[:200]:
        r, e = live[key], live[key]["element"]
        focused.append({"id": key, "revision": r["revision"], "type": e["type"], "bounds": boxes[key],
                        "text": e.get("text", ""), "semantic": semantic(e), "creator": r["creator"],
                        "editor": r["editor"], "mixed": r["mixed"], "links": sorted(links[key]),
                        "visual": visual(r)})
    # Fixed spatial buckets provide an overview in O(n), rather than clustering every pair.
    buckets = {}
    for key in live.keys() - selected:
        b = boxes[key]
        cell = (math.floor(b["x"] / 1200), math.floor(b["y"] / 1200))
        if cell not in buckets and len(buckets) >= 12:
            continue
        item = buckets.setdefault(cell, {"x": cell[0] * 1200, "y": cell[1] * 1200, "count": 0, "labels": []})
        item["count"] += 1
        text = live[key]["element"].get("text", "")
        if text and len(item["labels"]) < 2:
            item["labels"].append(text[:80])
    crop_ids = {key for crop in request.crops if crop.purpose == "initial" for key in crop.element_ids}
    required_visual = {f["id"] for f in focused if f["visual"]}
    overview = list(buckets.values())
    response = {"x": area["x"] + area["w"] + 100, "y": area["y"], "w": 4000, "h": 4000}
    if any(intersects(response, box) for box in boxes.values()):
        response["x"] = max((box["x"] + box["w"] for box in boxes.values()), default=0) + 100
    omitted = len(ordered) - len(focused)
    source = BoardSource(session_id=session_id, revision=revision,
        element_revisions={key: live[key]["revision"] for key in ordered},
        content_hash=digest(canonical({key: live[key] for key in ordered})),
        crop_hashes=tuple(c.asset_hash for c in request.crops))
    packet = ContextPacket(source=source, task_id=task.task_id if task else None,
        question=task.prompt if task else "Explain the focused board content and answer the learner's question.",
        focused=focused, overview=overview,
        coverage={"selected": len(ordered), "omitted": omitted, "outside_task": outside[:20], "outside_task_count": len(outside),
                  "missing_selection": sorted(set(request.selection) - live.keys()),
                  "missing_visual": sorted(required_visual - crop_ids), "complete": False},
        crops=request.crops, assistance=request.assistance,
        response_area=Rect(**response))
    # The model-facing projection is bounded; source receipts remain complete in storage.
    while packet.focused and len(canonical(model_context(packet)).encode("utf-8")) > MAX_CONTEXT:
        packet.focused.pop()
        omitted += 1
    packet.coverage["omitted"] = omitted
    packet.coverage["complete"] = bool(ordered) and not (omitted or outside or packet.coverage["missing_selection"] or required_visual - crop_ids)
    return packet


def model_context(packet: ContextPacket) -> dict:
    coverage = {key: value[:20] if isinstance(value, list) else value for key, value in packet.coverage.items()}
    return {"question": packet.question, "focused": packet.focused, "overview": packet.overview,
            "coverage": coverage, "assistance": packet.assistance.model_dump()}
