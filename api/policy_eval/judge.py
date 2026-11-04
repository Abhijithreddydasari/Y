"""Rubric judge (Muse Spark Open) and the held-out cross-judge (OpenAI gpt-6-luna)."""
from __future__ import annotations

import json

from .score import RUBRIC

JUDGE_SYSTEM = """You grade one short tutoring exchange for an automated evaluation of a tutor's teaching policy.
The student secretly holds the belief given as `hidden_belief`; the tutor was never told it (it may appear in the
tutor's learner brief if an earlier session found it). Score each item from 1 (poor) to 5 (excellent):
- diagnosis: the tutor names, or clearly anticipates, the specific wrong idea behind the student's answers.
- reteach: after a wrong answer the tutor corrects that idea from a different angle (a concrete number, a limiting
  case, a picture in words) instead of repeating the first explanation; if the student was never wrong, score how
  well the teaching would prevent the belief.
- probe: a check is built so that a student with the hidden belief would pick a specific wrong option (or give a
  specific wrong answer), and it tests the idea itself, not wording or trivia.
- correct: every statement, equation and answer key is right.
- concise: short board steps, one idea per step, ending in a question rather than a lecture.
final_correct: is the student's LAST answer correct ("yes", "no", or "unclear" if there was no last answer)?
critique: two to four sentences on what the tutor's policy should do differently next time. Be specific to this
exchange; do not praise. Return JSON only."""

_ITEM = {"type": "integer", "enum": [1, 2, 3, 4, 5]}
JUDGE_SCHEMA = {"type": "object", "additionalProperties": False,
                "required": [*RUBRIC, "final_correct", "critique"],
                "properties": {**{k: _ITEM for k in RUBRIC},
                               "final_correct": {"type": "string", "enum": ["yes", "no", "unclear"]},
                               "critique": {"type": "string"}}}


def exchange(scenario, turns: list[dict], answers: list[dict | None], board_lines) -> dict:
    """What the judges read: the belief, the question, each turn's board text and question with its key, the answers."""
    out = {"hidden_belief": scenario.belief, "student_knows": scenario.background, "student_question": scenario.question,
           "turns": []}
    for i, turn in enumerate(turns):
        entry = {"turn": i + 1, "board_and_voice": board_lines(turn["moves"]), "status": turn["status"]}
        q = next((m for m in turn["moves"] if m["type"] in ("check", "predict")), None)
        if q:
            entry["question"] = {"q": q["q"], "options": q["options"], "key": q.get("key", q.get("answer"))}
        if i < len(answers) and answers[i]:
            entry["student_answer"] = answers[i]["answer"]
            entry["verified_result"] = answers[i]["result"]
        out["turns"].append(entry)
    return out


async def rubric(clients, data: dict) -> dict:
    value = await clients.open_json("judge", JUDGE_SYSTEM, json.dumps(data, ensure_ascii=False), JUDGE_SCHEMA)
    for k in RUBRIC:
        if value.get(k) not in (1, 2, 3, 4, 5):
            raise ValueError(f"judge item {k} out of range")
    return value


_SCALE = [{"value": str(v), "description": d} for v, d in
          ((1, "poor"), (2, "weak"), (3, "adequate"), (4, "good"), (5, "excellent"))]
CROSS_ITEMS = {
    "diagnosis": "How well does the tutor name or anticipate the specific wrong idea in `hidden_belief`?",
    "reteach": "After a wrong answer, how well does the tutor correct that idea from a different angle rather than "
               "repeat itself (or, if never wrong, prevent the belief)?",
    "probe": "How well is a check built so a student with `hidden_belief` would pick a specific wrong option?",
    "correct": "How correct are all statements, equations and answer keys?",
    "concise": "How short and stepwise is the teaching, ending in a question rather than a lecture?",
}


async def cross_rubric(clients, data: dict) -> dict:
    """gpt-6-luna's expected 1-5 score per item, from its choice probabilities."""
    questions = [{"type": "choice", "name": name, "instructions": text, "choices": _SCALE}
                 for name, text in CROSS_ITEMS.items()]
    answers = await clients.decide("cross_judge", data, questions)
    out = {}
    for name, answer in zip(CROSS_ITEMS, answers):
        probs = {p["value"]: p.get("probability") or 0.0 for p in answer.get("probabilities") or ()}
        mass = sum(probs.values())
        out[name] = (sum(int(v) * p for v, p in probs.items()) / mass) if mass else float(answer.get("choice") or 3)
    return out
