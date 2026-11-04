"""Deterministic parts of a rollout's score, and the weighted total with the judge's rubric."""
from __future__ import annotations

import re

WEIGHTS = {"judge": 0.35, "resolved": 0.20, "probe": 0.15, "addresses": 0.10, "valid": 0.10, "length": 0.10}
LENGTH_BAND = (40, 260)  # words of board and voice text per turn; full credit inside, 0 at twice the top
RUBRIC = ("diagnosis", "reteach", "probe", "correct", "concise")
TEACHING = ("seg", "write", "equation", "say", "because")
_WORD = re.compile(r"[A-Za-z0-9]+(?:'[a-z]+)?")


def teaching_text(moves: list[dict]) -> str:
    """What the learner sees and hears, without the question."""
    out = []
    for m in moves:
        kind = m["type"]
        if kind == "seg":
            out.append(m["goal"])
        elif kind in ("write", "say", "because"):
            out.append(m["text"])
        elif kind == "equation":
            out.append(m["latex"])
        elif kind == "diagram":
            out.append(m["mermaid"])
        elif kind == "widget":
            out.append(f"[{m['kind']} widget] {m['spec']}")
        elif kind == "image":
            out.append(f"[illustration] {m['alt']}")
    return "\n".join(out)


def questions(moves: list[dict]) -> list[dict]:
    return [m for m in moves if m["type"] in ("check", "predict")]


def _key(m: dict) -> str:
    return m["answer"] if m["type"] == "predict" else m["key"]


def has_marker(text: str, markers) -> bool:
    low = text.lower()
    return any(marker in low for marker in markers)


def probe(turns: list[dict], markers, first_wrong: bool) -> float:
    """1 if a wrong option embodies the belief, or the student, answering from it, got the first check wrong."""
    for t in turns:
        for q in questions(t["moves"]):
            if any(has_marker(o, markers) for o in q["options"] if o != _key(q)):
                return 1.0
    return 1.0 if first_wrong else 0.0


def addresses(turns: list[dict], markers) -> float:
    """1 if the feedback turn's teaching names the belief, 0.5 if only the first turn did."""
    if len(turns) > 1 and has_marker(teaching_text(turns[1]["moves"]), markers):
        return 1.0
    return 0.5 if has_marker(teaching_text(turns[0]["moves"]), markers) else 0.0


def valid(turns: list[dict]) -> float:
    """Accepted moves over accepted + dropped, per turn (a failed turn is 0), averaged."""
    out = []
    for t in turns:
        if t["status"] == "failed":
            out.append(0.0)
            continue
        kept, dropped = len(t["moves"]), len(t["dropped"])
        out.append(kept / (kept + dropped) if kept + dropped else 0.0)
    return sum(out) / len(out) if out else 0.0


def words(moves: list[dict]) -> int:
    text = teaching_text(moves) + "\n" + "\n".join(q["q"] + " " + " ".join(q["options"]) for q in questions(moves))
    return len(_WORD.findall(text))


def length(turns: list[dict]) -> float:
    lo, hi = LENGTH_BAND
    out = []
    for t in turns:
        n = words(t["moves"])
        if n == 0:
            out.append(0.0)
        elif n < lo:
            out.append(n / lo)
        elif n <= hi:
            out.append(1.0)
        else:
            out.append(max(0.0, 1 - (n - hi) / hi))
    return sum(out) / len(out) if out else 0.0


def resolved(final: dict | None, judge_final: str | None) -> float:
    """The student's last answer: the verifier where it decides, else the judge's call."""
    if final is None:
        return 0.0
    if final["result"] == "correct":
        return 1.0
    if final["result"] == "incorrect":
        return 0.0
    return {"yes": 1.0, "no": 0.0}.get(judge_final or "", 0.5)


def judge_part(rubric: dict | None) -> float | None:
    if not rubric:
        return None
    return sum((rubric[k] - 1) / 4 for k in RUBRIC) / len(RUBRIC)


def total(parts: dict[str, float | None]) -> float:
    """Weighted sum; a missing part (judge call failed) is left out and the rest renormalised."""
    present = {k: v for k, v in parts.items() if v is not None and k in WEIGHTS}
    weight = sum(WEIGHTS[k] for k in present)
    return sum(WEIGHTS[k] * v for k, v in present.items()) / weight if weight else 0.0
