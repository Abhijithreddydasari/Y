"""Self-learning evaluation (paid, live): does the learner model learn, and does the tutor use it?

Simulated learners hold one hidden misconception each. Every learner runs two sessions through the
real API routes (tutor, OpenAI Decisions labels, Spark Open notes) on a throwaway SQLite file:
session 1 on a topic that exposes the belief, End session, then session 2 on a related topic. Each
persona runs twice on separate owners, once with Memory on in session 2 and once with it off, so
both arms start from a comparable session 1.

The learner is Spark Open role-playing from a persona. In session 1 it always answers from the hidden
belief (a persistent misconception that a generic explanation does not fix). In session 2 a
"receptive" learner drops it once the tutor's teaching in that session explicitly confronts it; a
"stubborn" one never does. It sees only what the tutor wrote on the board in that session.

Measured, per arm:
- detected: after session 1, a ledger entry matches the hidden belief (judged by the decision model);
- brief and because: session 2's first turn read the profile and cited it;
- probes: share of session-2 checks on the misconception's concept (re-checking it);
- success: mean expected credit of session-2 answers;
- calibration: Brier score of revision-1 belief means as predictions of session-2 credit, against
  a flat 0.5 prior, over answers whose concept was seen in session 1;
- ledger after session 2: the matched entry's status and strength.

Usage (from api): .venv\\Scripts\\python.exe scripts\\eval_learning.py [repeats] [out.json]
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from learning import profile  # noqa: E402
from learning.board_router import router as board_router  # noqa: E402
from learning.consolidate import NOTES_MODEL  # noqa: E402
from learning.decisions import OPENAI_BASE, OPENAI_DECISION_MODEL  # noqa: E402
from learning.learner_contracts import Observation  # noqa: E402
from learning.router import COOKIE, get_store, router  # noqa: E402
from learning.storage import CaptureStore, make_engine  # noqa: E402
from learning.tutor_models import BASETEN_BASE  # noqa: E402
from learning.tutor_router import router as tutor_router  # noqa: E402

MAX_ANSWERS = 3  # checks answered per session
PERSONAS = [
    {"name": "softmax-equalizes", "mode": "receptive",
     "belief": "softmax makes all the attention weights roughly equal, so attention averages the values evenly",
     "background": "dot products and vectors",
     "one": "Why does attention use a softmax over the scores? Teach me and check me with a multiple-choice question.",
     "two": "How does multi-head attention work? Check my understanding as we go."},
    {"name": "chain-rule-composes", "mode": "receptive",
     "belief": "the derivative of f(g(x)) is f'(g'(x)), the derivative of the outside applied to the derivative of the inside",
     "background": "derivatives of x^n, sin and e^x",
     "one": "Teach me the chain rule and check me with a question.",
     "two": "How do I differentiate sin(x^2) * e^x? Check me as we go."},
    {"name": "and-means-add", "mode": "stubborn",
     "belief": "the probability that two independent events both happen is the sum of their probabilities",
     "background": "what a probability between 0 and 1 means",
     "one": "Explain independent events and check me with a question.",
     "two": "What is the chance of rolling two sixes with two dice, and why? Check me."},
]
LEARNER_SYSTEM = (
    "You role-play a student in a tutoring session, for an automated evaluation. Stay in character. You know the "
    "basics of {background}. You sincerely believe: {belief}. Whenever a question touches that belief, answer from it. "
    "{rule} Answer briefly, as a student would: for an open question, give your answer and one or two sentences of "
    "your reasoning. Return JSON {{\"answer\": ...}}."
)
RULES = {"receptive": "Exception: if the tutor's teaching shown below, from THIS session, explicitly showed why that "
                      "belief is wrong (with an example or an argument), you have updated and answer correctly.",
         "stubborn": "You keep the belief whatever the teaching says."}
FIRST_SESSION_RULE = RULES["stubborn"]


def events(response) -> list[tuple[str, dict]]:
    out = []
    for frame in response.text.replace("\r\n", "\n").split("\n\n"):
        name = next((line[6:].strip() for line in frame.split("\n") if line.startswith("event:")), None)
        data = "\n".join(line[5:].strip() for line in frame.split("\n") if line.startswith("data:"))
        if name:
            out.append((name, json.loads(data)))
    return out


def board_text(got: list) -> list[str]:
    """What the tutor put on the board, as the learner would read it."""
    out = []
    for name, value in got:
        if name == "move":
            move = value["move"]
            text = " ".join(str(move[k]) for k in ("goal", "text", "latex", "q", "label") if move.get(k))
            if text:
                out.append(f"[{move['type']}] {text}")
    return out


def learner_answer(http: httpx.Client, persona: dict, teaching: list[str], question: dict, rule: str) -> dict:
    options = question.get("options") or []
    answer = {"type": "string", "enum": options} if options else {"type": "string"}
    body = {"model": NOTES_MODEL, "max_tokens": 4000, "reasoning_effort": "low",
            "response_format": {"type": "json_schema", "json_schema": {"name": "answer", "strict": True, "schema": {
                "type": "object", "additionalProperties": False, "required": ["answer"],
                "properties": {"answer": answer}}}},
            "messages": [{"role": "system", "content": LEARNER_SYSTEM.format(rule=rule, **persona)},
                         {"role": "user", "content": "TEACHING SO FAR THIS SESSION\n" + "\n".join(teaching)[-4000:]
                          + f"\n\nQUESTION: {question['q']}" + (f"\nOPTIONS: {options}" if options else "")}]}
    for _ in range(3):  # Spark Open sometimes spends the whole budget reasoning
        r = http.post(f"{BASETEN_BASE}/chat/completions", json=body, timeout=60,
                      headers={"Authorization": f"Bearer {os.environ['BASETEN_API_KEY']}"})
        r.raise_for_status()
        content = r.json()["choices"][0]["message"].get("content") or ""
        if content.strip():
            value = json.loads(content)["answer"]
            return {"choice": value} if options else {"text": value[:600]}
    raise RuntimeError("learner model returned nothing")


def judge(http: httpx.Client, belief: str, entries: list) -> tuple[str | None, float]:
    """Which ledger entry, if any, is the hidden belief? One decision-model call."""
    if not entries:
        return None, 1.0
    choices = [{"value": f"e{i}", "description": m.description} for i, m in enumerate(entries)]
    choices.append({"value": "none", "description": "None of these entries is the same wrong belief."})
    body = {"model": OPENAI_DECISION_MODEL,
            "input": [{"role": "user", "content": [{"type": "input_json", "data": {"hidden_belief": belief}}]}],
            "questions": [{"type": "choice", "name": "match", "choices": choices,
                           "instructions": "Which learner-profile entry describes the same wrong belief as "
                                           "`hidden_belief` (same idea, any wording)?"}]}
    r = http.post(f"{os.environ.get('OPENAI_BASE_URL') or OPENAI_BASE}/decisions", json=body, timeout=30,
                  headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})
    r.raise_for_status()
    answer = r.json()["answers"][0]
    p = {item["value"]: item["probability"] for item in answer["probabilities"]}[answer["choice"]]
    return (None if answer["choice"] == "none" else entries[int(answer["choice"][1:])].id), p


def run_session(client, http, sid, persona, prompt, rule) -> dict:
    """One session: ask, then answer up to MAX_ANSWERS checks as the learner. Returns what happened."""
    teaching, checks, first = [], [], None
    started = time.perf_counter()
    got = events(client.post(f"/learning/sessions/{sid}/tutor/turns",
                             json={"turn_id": str(uuid4()), "kind": "question", "text": prompt}))
    first = got
    for _ in range(MAX_ANSWERS):
        teaching += board_text(got)
        done = next((v for n, v in got if n == "done"), {})
        question = done.get("question")
        if not question:
            break
        body = learner_answer(http, persona, teaching, question, rule)
        checks.append({"q": question["q"], "kind": question.get("kind"), **body})
        got = events(client.post(f"/learning/sessions/{sid}/tutor/turns", json={
            "turn_id": str(uuid4()), "kind": "answer", "question_id": question["qid"], **body}))
    done = next((v for n, v in first if n == "done"), {})
    moves = [v["move"] for n, v in first if n == "move"]
    return {"checks": checks, "memory_items": len((done.get("memory") or {}).get("items", [])),
            "because": [m for m in moves if m["type"] == "because"],
            "first_moves": [f"{m['type']}: {(m.get('goal') or m.get('text') or m.get('q') or '')[:120]}" for m in moves[:4]],
            "ms": round((time.perf_counter() - started) * 1000)}


def sealed(client, sid) -> list[Observation]:
    rows = client.get(f"/learning/sessions/{sid}/evidence").json()["observations"]
    return [Observation.model_validate(r["observation"]) for r in rows if r["observation"]]


def prediction(revision, concept: str, dim: str) -> float | None:
    """Revision-1 mean for this concept × dimension, else the concept's mean over dimensions; None if unseen."""
    exact = [b for b in revision.beliefs if (b.concept, b.dimension) == (concept, dim)]
    near = exact or [b for b in revision.beliefs if b.concept == concept]
    return statistics.fmean(b.mean for b in near) if near else None


def run_arm(persona: dict, memory: bool, http: httpx.Client) -> dict:
    folder = tempfile.mkdtemp()
    capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'eval.db').as_posix()}"))
    capture.initialize()
    token = capture.issue_identity()
    owner = capture.owner_for_token(token)
    app = FastAPI()
    for r in (router, board_router, tutor_router):
        app.include_router(r)
    app.dependency_overrides[get_store] = lambda: capture
    store = profile.ProfileStore(capture)
    out = {"persona": persona["name"], "mode": persona["mode"], "memory": memory}
    with TestClient(app) as client:
        client.cookies.set(COOKIE, token)
        one = uuid4()
        capture.create_session(owner, one)
        out["one"] = run_session(client, http, one, persona, persona["one"], FIRST_SESSION_RULE)
        out["one"]["close"] = client.post(f"/learning/sessions/{one}/close").json()
        revision1, _ = store.latest(owner)
        entries = [m for m in (revision1.misconceptions if revision1 else ()) if m.status != "resolved"]
        matched, p = judge(http, persona["belief"], entries)
        entry = next((m for m in entries if m.id == matched), None)
        out["detected"] = {"id": matched, "p": round(p, 3), "status": entry.status if entry else None,
                           "strength": entry.strength if entry else None,
                           "ledger": [f"{m.status} {m.strength:.2f} {m.description}" for m in entries]}
        two = uuid4()
        capture.create_session(owner, two)
        client.put(f"/learning/sessions/{two}/memory", json={"memory": memory})
        out["two"] = run_session(client, http, two, persona, persona["two"], RULES[persona["mode"]])
        out["two"]["close"] = client.post(f"/learning/sessions/{two}/close").json()
        found = sealed(client, two)
        target = entry.concept if entry else None
        out["two"]["probes"] = sum(o.concept == target for o in found) if target else 0
        out["two"]["observations"] = len(found)
        out["two"]["credit"] = [round(profile.credit(o), 3) for o in found]
        pairs = [(prediction(revision1, o.concept, o.dimension), profile.credit(o)) for o in found] if revision1 else []
        pairs = [(p, c) for p, c in pairs if p is not None]
        out["calibration"] = {"n": len(pairs), "brier": round(statistics.fmean((p - c) ** 2 for p, c in pairs), 4) if pairs else None,
                              "brier_flat": round(statistics.fmean((0.5 - c) ** 2 for _, c in pairs), 4) if pairs else None}
        revision2, _ = store.latest(owner)
        after = next((m for m in revision2.misconceptions if m.id == matched), None) if revision2 and matched else None
        out["after"] = {"status": after.status, "strength": after.strength} if after else None
    capture.engine.dispose()
    return out


def summarize(results: list[dict]) -> None:
    print("\n=== per run ===")
    for r in results:
        two = r["two"]
        print(f"{r['persona']:<20} {r['mode']:<9} memory {'ON ' if r['memory'] else 'OFF'} | detected "
              f"{r['detected']['status'] or 'no':<9} | brief {two['memory_items']:>2} because {len(two['because'])} | "
              f"probes {two['probes']}/{two['observations']} | credit {two['credit']} | after {r['after']} | "
              f"brier {r['calibration']['brier']} vs flat {r['calibration']['brier_flat']} (n {r['calibration']['n']})")
    print("\n=== by arm ===")
    for memory in (True, False):
        arm = [r for r in results if r["memory"] == memory]
        credits = [c for r in arm for c in r["two"]["credit"]]
        probes = sum(r["two"]["probes"] for r in arm), sum(r["two"]["observations"] for r in arm)
        cal = [(r["calibration"]["brier"], r["calibration"]["brier_flat"], r["calibration"]["n"]) for r in arm
               if r["calibration"]["n"]]
        n = sum(c[2] for c in cal)
        print(f"memory {'ON ' if memory else 'OFF'}: runs {len(arm)}, detected {sum(bool(r['detected']['id']) for r in arm)}"
              f"/{len(arm)}, because {sum(bool(r['two']['because']) for r in arm)}/{len(arm)}, probes {probes[0]}/{probes[1]},"
              f" session-2 credit {statistics.fmean(credits) if credits else float('nan'):.2f} over {len(credits)} answers,"
              f" brier {sum(c[0] * c[2] for c in cal) / n if n else float('nan'):.3f} vs flat "
              f"{sum(c[1] * c[2] for c in cal) / n if n else float('nan'):.3f} (n {n})")


def main(repeats: int, out_path: str | None) -> None:
    print("LIVE, paid calls: tutor, OpenAI Decisions labels and judge, Spark Open notes and simulated learner")
    results = []
    with httpx.Client() as http:
        for _ in range(repeats):
            for persona in PERSONAS:
                for memory in (True, False):
                    started = time.perf_counter()
                    try:
                        result = run_arm(persona, memory, http)
                    except Exception as exc:  # one failed run is reported, the rest still count
                        print(f"! {persona['name']} memory={memory} failed: {type(exc).__name__}: {str(exc)[:200]}")
                        continue
                    result["ms"] = round((time.perf_counter() - started) * 1000)
                    results.append(result)
                    print(f"done {persona['name']} memory={'on' if memory else 'off'} in {result['ms'] / 1000:.0f} s", flush=True)
    summarize(results)
    if out_path:
        Path(out_path).write_text(json.dumps(results, indent=1, default=str), encoding="utf-8")
        print(f"\nfull results: {out_path}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1, sys.argv[2] if len(sys.argv) > 2 else None)
