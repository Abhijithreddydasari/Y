"""One rollout: question turn → student answer → feedback turn → student answer → judge, through the real turn path."""
from __future__ import annotations

import asyncio
import json
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from learning import personas, profile
from learning.storage import CaptureStore, make_engine
from learning.tutor_moves import TurnValidator
from learning.tutor_turn import (TurnInput, TurnRun, board_focus, build_messages, grade, question_record,
                                 session_memory, this_turn)

from . import judge as judges
from . import score
from .budget import BudgetExceeded
from .clients import RETRYABLE, CallFailed
from .scenarios import Scenario

FOLLOW_UP = "OK, I think I follow. Can you check whether I've got it?"
STUDENT_SYSTEM = """You are playing a student in an automated test of a tutor. Stay in character.
You are comfortable with {background}. You genuinely believe this: {belief}.
When a question touches that belief, answer the way a student who holds it would.
Change your mind only if the tutor's teaching shown below explicitly showed, with an example or an argument, why
that belief is wrong. A general explanation that never confronts it is not enough.
Answer briefly: for an open question, give the answer and one sentence of reasoning.
Return JSON with `answer` and `still_believes` (true if you still hold the belief)."""


class Briefs:
    """Each persona's real brief: the fixture built into a scratch SQLite file, compiled by the live code (no model calls)."""

    def __init__(self, root: Path | None = None):
        self.root = root or Path(tempfile.mkdtemp(prefix="y-policy-eval-"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = CaptureStore(make_engine(f"sqlite:///{(self.root / 'personas.sqlite3').as_posix()}"))
        self.store.initialize()
        self.builder = personas.PersonaStore(self.store)
        self.profiles = profile.ProfileStore(self.store)
        self.latest: dict[str, tuple] = {}

    def brief(self, scenario: Scenario):
        if scenario.persona not in self.latest:
            owner = personas.template_owner(scenario.persona)
            self.builder.build(owner, scenario.persona)
            self.latest[scenario.persona] = self.profiles.latest(owner)
        revision, index = self.latest[scenario.persona]
        return profile.compile_brief(revision, index, scenario.question)


def board_lines(moves: list[dict]) -> list[str]:
    return [line for line in score.teaching_text(moves).splitlines() if line.strip()]


def _user_text(messages: list[dict]) -> str:
    return "\n\n".join(part["text"] for part in messages[1]["content"] if part.get("type") == "text")


async def tutor_turn(clients, system_prompt: str, brief, history: list[dict], this: dict) -> dict:
    tutor = clients.tutor(system_prompt)
    brief_text = profile.render_brief(brief)
    messages = build_messages(brief_text, session_memory(history), board_focus(None), this)
    messages[0] = {"role": "system", "content": system_prompt}

    async def reserve():
        clients.budget.reserve("tutor_repair")

    for attempt in range(2):
        clients.budget.reserve("tutor")
        run = TurnRun(tutor, messages, TurnValidator(brief.refs if brief else frozenset(), 0), reserve=reserve)
        started, before = time.perf_counter(), dict(tutor.totals)
        async with clients.stream_sem:
            async for _ in run.events():
                pass
        usage = {k: v - before.get(k, 0) for k, v in tutor.totals.items()}
        clients.budget.record("tutor", tutor.model, run.error or run.status, (time.perf_counter() - started) * 1000, usage)
        if run.status == "failed" and run.error in RETRYABLE and attempt == 0:
            await asyncio.sleep(3)
            continue
        break
    return {"user": _user_text(messages), "moves": run.moves, "dropped": run.dropped, "status": run.status,
            "error": run.error, "repairs": run.repairs, "question_index": run.question_index, "usage": usage,
            "timing": {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()}}


def _question(turn: dict, n: int) -> dict | None:
    if turn["question_index"] is None:
        return None
    return question_record(turn["moves"][turn["question_index"]], f"t{n}.{turn['question_index']}")


async def student(clients, scenario: Scenario, teaching: list[str], question: dict) -> dict:
    options = question["options"]
    schema = {"type": "object", "additionalProperties": False, "required": ["answer", "still_believes"],
              "properties": {"answer": {"type": "string", "enum": options} if options else {"type": "string"},
                             "still_believes": {"type": "boolean"}}}
    user = ("TUTOR'S TEACHING SO FAR THIS SESSION\n" + "\n".join(teaching)[-5000:] + f"\n\nQUESTION: {question['q']}"
            + (f"\nOPTIONS: {json.dumps(options, ensure_ascii=False)}" if options else ""))
    value = await clients.open_json("student", STUDENT_SYSTEM.format(background=scenario.background, belief=scenario.belief),
                                    user, schema, max_tokens=4000)
    answer = str(value["answer"])[:600]
    turn = TurnInput(turn_id=uuid4(), kind="answer", question_id=question["qid"],
                     choice=answer if options else None, text="" if options else answer)
    return {**grade(question, turn), "still_believes": bool(value["still_believes"]), "via": turn}


def _public(answer: dict | None) -> dict | None:
    return None if answer is None else {k: v for k, v in answer.items() if k != "via"}


async def rollout(clients, scenario: Scenario, system_prompt: str, brief, cross: bool = False) -> dict:
    """Never raises for one scenario's failure except BudgetExceeded; `infra_error` marks a non-policy failure."""
    started = time.perf_counter()
    turns, answers, error = [], [], None
    try:
        t1 = await tutor_turn(clients, system_prompt, brief, [], this_turn(
            TurnInput(turn_id=uuid4(), kind="question", text=scenario.question), None, None))
        turns.append(t1)
        q1 = _question(t1, 1)
        record = {"seq": 1, "kind": "question", "status": "waiting" if q1 else ("failed" if t1["status"] == "failed" else "done"),
                  "moves": t1["moves"], "input": {"text": scenario.question}, "outcome": None, "question": q1}
        if q1:
            a1 = await student(clients, scenario, board_lines(t1["moves"]), q1)
            answers.append(a1)
            this2 = this_turn(a1["via"], q1, a1)
        else:
            answers.append(None)
            this2 = this_turn(TurnInput(turn_id=uuid4(), kind="question", text=FOLLOW_UP), None, None)
        t2 = await tutor_turn(clients, system_prompt, brief, [record], this2)
        turns.append(t2)
        q2 = _question(t2, 2)
        if q2:
            answers.append(await student(clients, scenario, board_lines(t1["moves"]) + board_lines(t2["moves"]), q2))
        else:
            answers.append(None)
    except BudgetExceeded:
        raise
    except CallFailed as exc:
        error = f"call_failed:{exc.code}"
    answers = [_public(a) for a in answers]
    data = judges.exchange(scenario, turns, answers, board_lines)
    rubric, cross_scores, judge_error = None, None, None
    if error is None:
        try:
            rubric = await judges.rubric(clients, data)
        except BudgetExceeded:
            raise
        except (CallFailed, ValueError) as exc:
            judge_error = getattr(exc, "code", None) or str(exc)
        if cross:
            try:
                cross_scores = await judges.cross_rubric(clients, data)
            except BudgetExceeded:
                raise
            except (CallFailed, ValueError, KeyError, TypeError) as exc:
                cross_scores = {"error": getattr(exc, "code", None) or type(exc).__name__}
    first = answers[0] if answers else None
    final = answers[-1] if len(answers) > 1 else None
    parts = None
    if error is None:
        parts = {"judge": score.judge_part(rubric),
                 "resolved": score.resolved(final, (rubric or {}).get("final_correct")),
                 "probe": score.probe(turns, scenario.markers, bool(first and first["result"] == "incorrect")),
                 "addresses": score.addresses(turns, scenario.markers),
                 "valid": score.valid(turns), "length": score.length(turns)}
    return {"scenario": scenario.id, "split": scenario.split, "kind": scenario.kind, "persona": scenario.persona,
            "brief": profile.render_brief(brief), "turns": turns, "answers": answers, "rubric": rubric,
            "cross": cross_scores, "judge_error": judge_error, "parts": parts,
            "score": score.total(parts) if parts else 0.0, "infra_error": error,
            "ms": round((time.perf_counter() - started) * 1000)}
