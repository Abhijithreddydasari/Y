"""Live check of the evidence labeler against hand labels (paid: one Decisions call per scored answer).

The answers go through the real capture store, `label_request`, the configured labeler, `merge_labels`
and the reducer's `sightings`, so "flagged" means what the learner's ledger would really do.

    .venv\\Scripts\\python.exe -m policy_eval.label_check [out.json]
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv

API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API))
load_dotenv(API.parent / ".env")

from learning import consolidate, observations, profile  # noqa: E402
from learning.decisions import ProviderFailure, evidence_labeler  # noqa: E402
from learning.storage import CaptureStore, make_engine  # noqa: E402
from learning.tutor_turn import TurnInput, grade  # noqa: E402

CASES_PATH = Path(__file__).resolve().parent / "label_cases.json"
MAX_CALLS = 50
CONCURRENCY = 4
GROUPS_DETECT = ("mcq_belief", "mcq_other_wrong", "free_recurrence", "free_new")
GROUPS_CLEAN = ("slip", "correct_paraphrase", "unanswered", "injection")


def load_cases(path: Path = CASES_PATH) -> list[dict]:
    cases = json.loads(path.read_text(encoding="utf-8"))["cases"]
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("case ids must be unique")
    for c in cases:
        if c["options"] and (c["key"] not in c["options"] or c["answer"] not in c["options"]):
            raise ValueError(f"{c['id']}: key and answer must be options")
    return cases


def expected_id(case: dict) -> str | None:
    """The misconception id the labeler should rank first, or the literal `other` / `none`; None when not scored."""
    mis = case["mis"]
    if mis == "chosen":
        return f"{case['concept']}/{observations.slug(case['answer'])}"[:120]
    if mis and mis.startswith("earlier:"):
        return mis.partition(":")[2]
    return mis


def score_case(case: dict, observation, fields: dict, dist: dict) -> dict:
    """One case's result; `observation` is the merged Observation or None when the outcome stayed unknown."""
    outcome = observation.outcome if observation is not None else None
    top = fields.get("misconception", {}).get("choice")
    want = expected_id(case)
    masses = profile.sightings(observation, profile.weight(observation)) if observation is not None else {}
    flagged = sorted(m for m, v in masses.items() if v >= profile.SIGHTING)
    miss = 1 - profile.credit(observation) if observation is not None else 0.0
    other_mass = (observation.other_misconception_p or 0.0) * miss if observation is not None else 0.0
    return {"id": case["id"], "group": case["group"], "answer": case["answer"], "outcome": outcome,
            "outcome_ok": outcome in case["outcome"], "want": want, "top": top,
            "top_p": fields.get("misconception", {}).get("p"), "match": None if want is None else (top or "none") == want,
            "flagged": flagged, "other_mass": round(other_mass, 3), "miss_class": fields.get("miss_class", {}).get("choice"),
            "miss_p": fields.get("miss_class", {}).get("p"), "outcome_p": dist.get("outcome")}


def summarize(results: list[dict]) -> dict:
    done = [r for r in results if not r.get("error")]

    def part(groups):
        rows = [r for r in done if r["group"] in groups]
        return {"n": len(rows), "match": sum(1 for r in rows if r["match"])}

    decided = [r for r in done if r["outcome_p"] is not None]
    clean = [r for r in done if r["group"] in GROUPS_CLEAN]
    taken = [r for r in done if r["miss_p"] is not None and r["outcome"] != "correct"]
    out = {"cases": len(results), "failed": len(results) - len(done),
           "outcome_model_decided": {"n": len(decided), "agree": sum(r["outcome_ok"] for r in decided)},
           "outcome_all": {"n": len(done), "agree": sum(r["outcome_ok"] for r in done)},
           "by_group": {g: part((g,)) for g in (*GROUPS_DETECT, *GROUPS_CLEAN)},
           "detect": part(GROUPS_DETECT),
           "false_flags": {"n": len(clean), "ledger": sum(1 for r in clean if r["flagged"]),
                           "other_mass": sum(1 for r in clean if r["other_mass"] >= profile.SIGHTING)},
           "miss_class_taken": {"n": len(taken), "taken": sum(1 for r in taken if r["miss_p"] >= observations.ACCEPT)}}
    return out


async def run_case(case, store, labeler, owner, sid, sem) -> dict:
    question = {"kind": "mcq" if case["options"] else "free", "q": case["q"], "options": case["options"], "key": case["key"],
                "concept": case["concept"], "dim": "understand", "qid": f"check.{case['id']}"}
    body = TurnInput(turn_id=uuid4(), kind="answer", question_id=question["qid"],
                     **({"choice": case["answer"]} if case["options"] else {"text": case["answer"]}))
    graded = grade(question, body)
    view, _ = store.capture_answer(owner, sid, str(body.turn_id), question, case["answer"], graded, case["via"], [])
    row = store.claim(owner, view["observation_id"], charge=False)  # the raw row the live labeler works from
    if row is None:
        return {"id": case["id"], "group": case["group"], "error": "not_pending"}
    state, asked = observations.label_request(row, [], case.get("earlier"))
    try:
        async with sem:
            started = time.perf_counter()  # the provider call alone, not the wait for a slot
            response, _raw = await labeler.label(state, asked)
            elapsed = time.perf_counter() - started
    except (ProviderFailure, TimeoutError) as exc:
        return {"id": case["id"], "group": case["group"], "error": getattr(exc, "code", type(exc).__name__)}
    observation, trace, _ = observations.merge_labels(row, response, labeler.provider_name)
    return {**score_case(case, observation, trace["fields"], trace["distributions"]),
            "ms": round(elapsed * 1000), "usage": trace["usage"]}


NAMING_POSITIVE, NAMING_NEGATIVE = ("d1", "d2", "d3", "d4", "d5", "d6"), ("e1", "e2", "e3", "e4", "i1", "i2")


async def naming_case(case, store, labeler, writer, owner, sem) -> dict:
    """One answer as its own session through the real label, flag, Spark Open close call and `keep_named`."""
    sid = str(uuid4())
    store.capture.create_session(owner, sid)
    question = {"kind": "mcq" if case["options"] else "free", "q": case["q"], "options": case["options"], "key": case["key"],
                "concept": case["concept"], "dim": "understand", "qid": f"name.{case['id']}"}
    body = TurnInput(turn_id=uuid4(), kind="answer", question_id=question["qid"], text=case["answer"])
    view, _ = store.capture_answer(owner, sid, str(body.turn_id), question, case["answer"], grade(question, body), case["via"], [])
    row = store.claim(owner, view["observation_id"], charge=False)
    state, asked = observations.label_request(row, [], case.get("earlier"))
    async with sem:
        response, _raw = await labeler.label(state, asked)
        observation, _trace, _ = observations.merge_labels(row, response, labeler.provider_name)
        answers = {str(observation.observation_id): {"q": case["q"], "answer": case["answer"]}}
        marked = consolidate.flagged([observation], answers)
        raw, _info = await writer.write(consolidate.evidence_payload([observation], answers, []))
    named, dropped = consolidate.keep_named(raw, [observation], answers)
    return {"id": case["id"], "group": case["group"], "answer": case["answer"], "flagged": bool(marked),
            "named": [n["description"] for n in named], "dropped": dropped, "belief": case["mis"]}


async def naming(out_path: str | None) -> int:
    cases = {c["id"]: c for c in load_cases()}
    labeler, picked = evidence_labeler(), [cases[i] for i in (*NAMING_POSITIVE, *NAMING_NEGATIVE)]
    print(f"naming check: {len(picked)} labels and {len(picked)} Spark Open calls")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
        capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'naming.db').as_posix()}"))
        capture.initialize()
        owner = capture.owner_for_token(capture.issue_identity())
        store = observations.ObservationStore(capture)
        sem = asyncio.Semaphore(CONCURRENCY)
        writer = consolidate.NotesWriter()
        results = await asyncio.gather(*(naming_case(c, store, labeler, writer, owner, sem) for c in picked), return_exceptions=True)
        capture.engine.dispose()
    rows = [r if isinstance(r, dict) else {"error": type(r).__name__, "detail": str(getattr(r, "code", ""))} for r in results]
    for r in rows:
        print(json.dumps(r, ensure_ascii=False))
    if out_path:
        Path(out_path).write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    return 0


async def main(out_path: str | None) -> int:
    cases = load_cases()
    if len(cases) > MAX_CALLS:
        raise SystemExit(f"{len(cases)} cases is over the {MAX_CALLS} call cap")
    labeler = evidence_labeler()
    print(f"labeler {labeler.provider_name}:{labeler.model} configured={labeler.configured}; {len(cases)} paid calls at most")
    if not labeler.configured:
        raise SystemExit("the selected provider's key is not set")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
        capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'check.db').as_posix()}"))
        capture.initialize()
        owner = capture.owner_for_token(capture.issue_identity())
        sid = str(uuid4())
        capture.create_session(owner, sid)
        store = observations.ObservationStore(capture)
        sem = asyncio.Semaphore(CONCURRENCY)
        results = await asyncio.gather(*(run_case(c, store, labeler, owner, sid, sem) for c in cases))
        capture.engine.dispose()
    summary = summarize(results)
    print(json.dumps(summary, indent=1))
    for r in results:
        print(json.dumps(r, ensure_ascii=False))
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(json.dumps({"model": labeler.model, "summary": summary, "results": results}, indent=1,
                                             ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    args = sys.argv[1:]
    if args[:1] == ["naming"]:
        raise SystemExit(asyncio.run(naming(args[1] if len(args) > 1 else None)))
    raise SystemExit(asyncio.run(main(args[0] if args else None)))
