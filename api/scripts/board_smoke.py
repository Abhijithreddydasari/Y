"""Synthetic end-to-end board smoke. No network requests without --live.

Start the learning API first. The API, not this script, loads provider keys.
Makes one native conceptual assessment and one visual numeric assessment.
This is a contract/recovery check, not a real-handwriting accuracy benchmark.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from io import BytesIO
from uuid import uuid4

import httpx
from PIL import Image, ImageDraw


def digit_four():
    """Known-ground-truth synthetic ink, with two separate pen strokes."""
    points = [[(110, 30), (50, 110), (150, 110)], [(120, 30), (120, 180)]]
    image = Image.new("RGB", (220, 220), "white")
    draw = ImageDraw.Draw(image)
    for stroke in points:
        draw.line(stroke, fill="black", width=5)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue(), points


async def smoke(live=False, base_url="http://127.0.0.1:8101", client=None):
    if not live:
        return {"live_requested": False, "network_calls": 0,
                "cases": ["native linear-algebra explanation -> decision provider", "synthetic digit 4 -> Meta reader -> numerical verifier"],
                "paid_call_bound": "At most 1 decision call and 2 vision calls; no teaching calls.",
                "next_step": "Start the API with root .env, then rerun with --live."}
    if client is None:
        async with httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=40, follow_redirects=False) as owned:
            return await smoke(True, base_url, owned)

    async def request(path, body=None, content=None):
        response = await client.request("GET" if body is None and content is None else "POST", "/learning/" + path,
            **({"content": content, "headers": {"Content-Type": "image/png"}} if content is not None else {"json": body} if body is not None else {}))
        if response.status_code != 200:
            raise RuntimeError(f"smoke_http_{response.status_code}")
        return response.json()

    await request("identity", {})
    sid = str(uuid4())
    await request("sessions", {"session_id": sid})
    revision, cases = 0, []
    for visual, task in [(False, "linear.eigenvector.explain.v1"), (True, "cv.stereo.depth.v1")]:
        rid = str(uuid4())
        region = await request(f"sessions/{sid}/board/regions", {"region_id": rid, "task_id": task, "expected_revision": revision})
        revision += 1
        x, y = region["bounds"]["x"] + 40, region["bounds"]["y"] + 40
        crops = []
        if visual:
            png, strokes = digit_four()
            asset = await request(f"sessions/{sid}/board/assets", content=png)
            edits = [{"actor": "human", "element": {"id": f"ink-{i}", "type": "freedraw", "x": x, "y": y,
                       "width": 220, "height": 220, "points": points, "version": 1}} for i, points in enumerate(strokes)]
            crops = [{"asset_hash": asset["hash"], "bounds": {"x": x, "y": y, "w": 220, "h": 220},
                      "element_ids": [edit["element"]["id"] for edit in edits], "purpose": purpose} for purpose in ("initial", "detail")]
        else:
            edits = [{"actor": "human", "element": {"id": "explanation", "type": "text", "x": x, "y": y,
                      "width": 700, "height": 80, "version": 1,
                      "text": "By linearity A(-2v)=-2Av=3(-2v), so the scaled nonzero vector still has eigenvalue 3."}}]
        await request(f"sessions/{sid}/board/edits", {"operation_id": str(uuid4()), "expected_revision": revision, "edits": edits})
        revision += 1
        aid = str(uuid4())
        saved = await request(f"sessions/{sid}/board/attempts", {"request_id": aid, "revision": revision, "region_id": rid, "crops": crops})
        assessed = await request(f"board-attempts/{aid}/assess", {})
        recovered = await request(f"board-attempts/{aid}")
        result = assessed.get("result") or {}
        reading = result.get("interpretation") or {}
        observations = result.get("observations", [])
        receipt = saved["packet"]["source"]
        cases.append({"case": "synthetic_ink_four" if visual else "native_linear_explanation",
            "saved_before_assessment": saved.get("result") is None,
            "source_preserved": receipt == assessed["packet"]["source"] == recovered["packet"]["source"],
            "coverage_complete": saved["packet"]["coverage"]["complete"],
            "result_recovered": recovered.get("result") == assessed.get("result"),
            "status": result.get("status"), "provider_error": result.get("provider_error"),
            "reading": [{"text": item["text"], "status": item["status"]} for item in reading.get("items", [])],
            "observations": [{"label": item["label"], "status": item["status"]} for item in observations],
            "matches_reference": any(item["label"] == "supported" for item in observations),
            "latency_ms": result.get("latency_ms"), "vision_calls": reading.get("calls", 0),
            "vision_usage": reading.get("usage", {}), "decision_usage": result.get("usage", {}),
            "profile_updated": assessed.get("profile_updated")})
    return {"live_requested": True, "synthetic_only": True,
            "contract_checks_passed": all(c["source_preserved"] and c["coverage_complete"] and c["result_recovered"] and not c["provider_error"] for c in cases),
            "cases": cases, "note": "Inspect readings and reference matches. This does not measure handwriting accuracy or learning outcomes."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Send synthetic data through the running API; can incur provider charges")
    parser.add_argument("--base-url", default="http://127.0.0.1:8101")
    args = parser.parse_args()
    try:
        report = asyncio.run(smoke(args.live, args.base_url))
    except (RuntimeError, httpx.HTTPError):
        print(json.dumps({"error": "Could not complete the smoke. Check API startup, .env, and server logs; no keys are printed."}))
        raise SystemExit(1)
    print(json.dumps(report, indent=2))
    if report.get("contract_checks_passed") is False:
        raise SystemExit(1)
