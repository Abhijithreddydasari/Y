"""Live check of H5 (paid calls): session 1 → End session → session 2 first turn with Memory on vs off.

Runs the real tutor, evidence labeler and Spark Open teaching notes through the API routes on a
throwaway SQLite file. Session 1 asks about softmax attention and answers its check with a wrong
option, then closes. Each pair then asks the same session-2 question once with Memory on and once
with Memory off, and prints the first moves, `because` chips and the brief the tutor read.
Usage (from api): .venv\\Scripts\\python.exe scripts\\live_memory.py [pairs]
"""
from __future__ import annotations

import json
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
from learning.tutor_storage import TutorStore  # noqa: E402

SESSION_ONE = "Why does attention use a softmax over the scores? Teach me and check me with a multiple-choice question."
SESSION_TWO = "How does multi-head attention work?"


def events(response) -> list[tuple[str, dict]]:
    out = []
    for frame in response.text.replace("\r\n", "\n").split("\n\n"):
        name = next((line[6:].strip() for line in frame.split("\n") if line.startswith("event:")), None)
        data = "\n".join(line[5:].strip() for line in frame.split("\n") if line.startswith("data:"))
        if name:
            out.append((name, json.loads(data)))
    return out


def turn(client, sid, **body):
    started = time.perf_counter()
    got = events(client.post(f"/learning/sessions/{sid}/tutor/turns", json={"turn_id": str(uuid4()), **body}))
    return got, (time.perf_counter() - started) * 1000


def show(label: str, got: list, ms: float) -> None:
    moves = [v["move"] for n, v in got if n == "move"]
    done = next((v for n, v in got if n == "done"), {})
    memory = done.get("memory") or {}
    print(f"\n--- {label}: {len(moves)} moves, total {ms:.0f} ms, first move {done.get('timing', {}).get('first_move_ms')} ms, "
          f"dropped {done.get('dropped')}, memory items {len(memory.get('items', []))}")
    for move in moves[:6]:
        text = move.get("goal") or move.get("text") or move.get("latex") or move.get("q") or ""
        refs = f" refs={move['refs']}" if move["type"] == "because" else ""
        print(f"  {move['type']:<9}{refs} {text[:150]}")


def main(pairs: int) -> None:
    folder = tempfile.mkdtemp()
    capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'live.db').as_posix()}"))
    capture.initialize()
    token = capture.issue_identity()
    owner = capture.owner_for_token(token)
    app = FastAPI()
    for r in (router, board_router, tutor_router):
        app.include_router(r)
    app.dependency_overrides[get_store] = lambda: capture
    print("LIVE, paid calls: tutor (Muse Spark 1.3), evidence labels (EVIDENCE_LABEL_PROVIDER), notes (Spark Open)")
    with TestClient(app) as client:
        client.cookies.set(COOKIE, token)
        one = uuid4()
        capture.create_session(owner, one)
        got, ms = turn(client, one, kind="question", text=SESSION_ONE)
        show("session 1 question", got, ms)
        question = next((v["question"] for n, v in got if n == "done"), None)
        if not question:
            raise SystemExit("session 1 turn asked no question; run again")
        key = TutorStore(capture).history(owner, str(one))[-1]["question"]["key"]
        wrong = next((o for o in question["options"] if o != key), None)
        body = {"choice": wrong} if wrong else {"text": "it makes the scores add up to the mean"}
        got, ms = turn(client, one, kind="answer", question_id=question["qid"], **body)
        print(f"\nanswered {body} (key {key!r}) -> {next(v for n, v in got if n == 'turn')['outcome']}")
        started = time.perf_counter()
        closed = client.post(f"/learning/sessions/{one}/close").json()
        print(f"\nclose in {(time.perf_counter() - started) * 1000:.0f} ms: revision {closed.get('revision')}, sealed "
              f"{closed.get('sealed')}, left out {closed.get('left_out')}, misconceptions {closed.get('misconceptions')}")
        print(f"  notes trace {closed.get('notes_trace')}")
        for note in closed.get("notes", []):
            print(f"  note: {note}")
        replay = client.post(f"/learning/sessions/{one}/close").json()
        print(f"  replayed close: replayed={replay['replayed']} revision={replay['revision']} sealed={replay['sealed']}")
        brief = client.get("/learning/profile", params={"q": SESSION_TWO}).json()["brief_text"]
        print("\nbrief for session 2:\n" + "\n".join("  " + line for line in brief.splitlines()))
        for pair in range(pairs):
            for memory in (True, False):
                sid = uuid4()
                capture.create_session(owner, sid)
                client.put(f"/learning/sessions/{sid}/memory", json={"memory": memory})
                got, ms = turn(client, sid, kind="question", text=SESSION_TWO)
                show(f"pair {pair + 1} memory {'ON' if memory else 'OFF'}", got, ms)
    capture.engine.dispose()


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2)
