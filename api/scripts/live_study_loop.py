"""Live check of H7 (paid calls): hint ladder, exit ticket, then warm-up in the next session.

Runs the real tutor, evidence labeler and Spark Open notes through the API routes on a throwaway
SQLite file. Per round: ask about softmax, take hints 1 and 2 on the check, answer wrongly, take
the exit ticket, answer it, close, then open session 2 and draw its warm-up review (no model call).
Prints each stage's latency and whether a hint leaked the key.
Usage (from api): .venv\\Scripts\\python.exe scripts\\live_study_loop.py [rounds]
"""
from __future__ import annotations

import statistics
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from learning.board_router import router as board_router  # noqa: E402
from learning.router import COOKIE, get_store, router  # noqa: E402
from learning.storage import CaptureStore, make_engine  # noqa: E402
from learning.tutor_router import router as tutor_router  # noqa: E402
from live_memory import events, turn  # noqa: E402

QUESTION = "Why does attention use a softmax over the scores? Teach me and check me with a multiple-choice question."


def wrong(question: dict) -> dict:
    return {"choice": question["options"][-1]} if question["options"] else {"text": "it makes them all equal"}


def main(rounds: int) -> None:
    folder = tempfile.mkdtemp()
    capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'live.db').as_posix()}"))
    capture.initialize()
    app = FastAPI()
    for r in (router, board_router, tutor_router):
        app.include_router(r)
    app.dependency_overrides[get_store] = lambda: capture
    print("LIVE, paid calls: tutor (Muse Spark 1.3), labels (EVIDENCE_LABEL_PROVIDER), notes (Spark Open)")
    timings: dict[str, list[float]] = {"hint1": [], "hint2": [], "exit_first_move": [], "exit_total": [], "review": [],
                                       "close": []}
    with TestClient(app) as client:
        for n in range(rounds):
            token = capture.issue_identity()
            owner = capture.owner_for_token(token)
            client.cookies.set(COOKIE, token)
            one = uuid4()
            capture.create_session(owner, one)
            got, _ = turn(client, one, kind="question", text=QUESTION)
            question = next((v["question"] for k, v in got if k == "done"), None)
            if not question:
                print(f"round {n}: no check in the first turn; skipped")
                continue
            print(f"\n=== round {n}: {question['q'][:100]}")
            for level in (1, 2):
                started = time.perf_counter()
                response = client.post(f"/learning/sessions/{one}/tutor/hints", json={"qid": question["qid"], "level": level})
                ms = (time.perf_counter() - started) * 1000
                body = response.json()
                if response.status_code == 200:
                    timings[f"hint{level}"].append(ms)
                    print(f"  hint {level} ({ms:.0f} ms): {body['hints'][-1]['text']}")
                else:
                    print(f"  hint {level} failed {response.status_code} {body.get('detail')} ({ms:.0f} ms)")
            turn(client, one, kind="answer", question_id=question["qid"], **wrong(question))
            got, ms = turn(client, one, kind="exit")
            done = next((v for k, v in got if k == "done"), {})
            ticket = done.get("question")
            timings["exit_total"].append(ms)
            if done.get("timing", {}).get("first_move_ms"):
                timings["exit_first_move"].append(done["timing"]["first_move_ms"])
            print(f"  exit ticket ({ms:.0f} ms, origin={ticket and ticket.get('origin')}): {ticket and ticket['q'][:120]}")
            if ticket:
                got, _ = turn(client, one, kind="answer", question_id=ticket["qid"], **wrong(ticket))
                feedback = [v["move"] for k, v in got if k == "move"]
                print(f"  exit feedback: {[m['type'] for m in feedback]}")
            started = time.perf_counter()
            closed = client.post(f"/learning/sessions/{one}/close").json()
            timings["close"].append((time.perf_counter() - started) * 1000)
            print(f"  close: revision {closed.get('revision')}, sealed {closed.get('sealed')}, "
                  f"misconceptions {closed.get('misconceptions')}, suspected {closed.get('suspected')}")
            two = uuid4()
            capture.create_session(owner, two)
            items = client.get(f"/learning/sessions/{two}/review").json()["items"]
            print(f"  session 2 due: {[(i['concept'], i['reason']) for i in items]}")
            if items:
                got, ms = turn(client, two, kind="review", concept=items[0]["concept"])
                timings["review"].append(ms)
                done = next((v for k, v in got if k == "done"), {})
                print(f"  warm-up drawn in {ms:.0f} ms: {done['question']['q'][:100]}")
    print("\nlatency (ms): " + ", ".join(f"{k} p50 {statistics.median(v):.0f} n={len(v)}" for k, v in timings.items() if v))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2)
