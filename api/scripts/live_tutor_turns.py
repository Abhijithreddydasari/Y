"""Live tutor-turn latency run against a running capture API (paid Meta calls).

Usage from api: .venv\\Scripts\\python.exe scripts\\live_tutor_turns.py http://127.0.0.1:8111 10
Runs `turns` turns per subject (two subjects): questions, and answers whenever a check waits.
Prints one line per turn and a JSON summary; client times include the local HTTP hop.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
from uuid import uuid4

import httpx

SUBJECTS = {
    "attention": {"board": None, "questions": [
        "Why do transformers divide attention scores by sqrt(d_k)?",
        "What would happen if we divided by d_k instead?",
        "How does the temperature of a softmax relate to this?",
        "Just tell me how multi-head attention changes the scaling."]},
    "linear-algebra": {"board": "A = [[2, 1], [1, 2]]\nv = (1, 1)\nAv = (3, 3)", "questions": [
        "Is v an eigenvector of A? Check my work on the board.",
        "What is the other eigenvector of A?",
        "Why are the eigenvectors of a symmetric matrix perpendicular?",
        "Just tell me what the eigen-decomposition of A is."]},
}


def events(response):
    name = None
    for line in response.iter_lines():
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:") and name:
            yield name, json.loads(line[5:])
            name = None


def put_board(client, sid, text):
    element = {"id": "work-1", "type": "text", "x": 120, "y": 140, "width": 320, "height": 90, "text": text,
               "fontSize": 24, "version": 1}
    client.post(f"/learning/sessions/{sid}/board/edits", json={"operation_id": str(uuid4()), "expected_revision": 0,
                "edits": [{"element": element, "actor": "human"}], "viewport": {"x": 0, "y": 0, "w": 1400, "h": 1000}}).raise_for_status()
    return client.get(f"/learning/sessions/{sid}/board").json()["revision"]


def turn(client, sid, body):
    started = time.perf_counter()
    sample = {"kind": body["kind"], "first_move_s": None}
    with client.stream("POST", f"/learning/sessions/{sid}/tutor/turns", json=body, timeout=90) as response:
        sample["http"] = response.status_code
        if response.status_code != 200:
            sample["error"] = response.read().decode()[:200]
            return sample, None
        for name, value in events(response):
            if name == "move" and sample["first_move_s"] is None:
                sample["first_move_s"] = time.perf_counter() - started
            elif name == "error":
                sample["error"] = value["code"]
            elif name == "done":
                sample.update(status=value["status"], moves=value.get("moves"), dropped=value.get("dropped"),
                              repairs=value.get("repairs"), server=value.get("timing"), usage=value.get("usage"))
                question = value["question"]
    sample["total_s"] = time.perf_counter() - started
    return sample, question


def main(base: str, per_subject: int) -> None:
    samples = []
    with httpx.Client(base_url=base, timeout=30) as client:
        client.post("/learning/identity").raise_for_status()
        for subject, plan in SUBJECTS.items():
            sid = str(uuid4())
            client.post("/learning/sessions", json={"session_id": sid}).raise_for_status()
            revision = put_board(client, sid, plan["board"]) if plan["board"] else 0
            questions, question, answered = iter(plan["questions"]), None, 0
            for n in range(per_subject):
                board = {"request_id": str(uuid4()), "revision": revision, "viewport": {"x": 0, "y": 0, "w": 1400, "h": 1000}}
                if question:
                    # Alternate a first-option answer and a free-text attempt to cover both feedback paths.
                    pick = question["options"][answered % len(question["options"])] if question["options"] else None
                    body = {"turn_id": str(uuid4()), "kind": "answer", "question_id": question["qid"], "confidence": 60,
                            **({"choice": pick} if pick else {"text": "I think it is about keeping the variance near one"}), "board": board}
                    answered += 1
                else:
                    text = next(questions, None) or "Can you give me one more example?"
                    body = {"turn_id": str(uuid4()), "kind": "question", "text": text, "board": board}
                sample, question = turn(client, sid, body)
                sample["subject"] = subject
                samples.append(sample)
                server = sample.get("server") or {}
                print(f"{len(samples):2d} {subject:15s} {sample['kind']:8s} first_move={sample['first_move_s'] or 0:5.2f}s "
                      f"total={sample['total_s']:5.2f}s status={sample.get('status')} moves={sample.get('moves')} "
                      f"dropped={sample.get('dropped')} repairs={sample.get('repairs')} "
                      f"server_first_token={server.get('first_token_ms')}ms cached={(sample.get('usage') or {}).get('cached_tokens')} "
                      f"in={(sample.get('usage') or {}).get('input_tokens')} err={sample.get('error')}", flush=True)
    firsts = sorted(s["first_move_s"] for s in samples if s["first_move_s"] is not None)
    if firsts:
        p95 = firsts[min(len(firsts) - 1, round(0.95 * (len(firsts) - 1)))]
        print(json.dumps({"n": len(samples), "with_moves": len(firsts), "p50_s": round(statistics.median(firsts), 3),
                          "p95_s": round(p95, 3), "max_s": round(firsts[-1], 3),
                          "dropped": sum(s.get("dropped") or 0 for s in samples), "repairs": sum(s.get("repairs") or 0 for s in samples),
                          "statuses": {k: sum(s.get("status") == k for s in samples) for k in ("waiting", "done", "incomplete", "failed", None)}}))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8111", int(sys.argv[2]) if len(sys.argv) > 2 else 10)
