"""Study loop extras (H7): warm-up reviews due from the profile, hint ladder, exit ticket, canvas list.

Reviews and the canvas list need no model call. A review re-asks the learner's own latest check on a
due concept, so its answer becomes ordinary evidence. Hints are one small, bounded tutor call each.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from datetime import datetime, timezone

from sqlalchemy import Column, Float, ForeignKey, Integer, String, Table, Text, insert, select
from sqlalchemy.exc import IntegrityError

from .learner_contracts import ProfileRevision
from .observations import observations
from .profile import _hours
from .storage import CaptureStore, StoreError, metadata, sessions
from .tutor_storage import turns

REVIEW_LIMIT = 3
RETAINED, SHAKY_MEAN = 0.5, 0.6  # due below these
HINT_LEVELS = (1, 2)  # 3, the answer itself, is the card's existing "Just tell me"
HINT_TOKENS = 1200  # minimal effort reasons for ~450 tokens; a hint is under 80
CANVAS_LIMIT = 30

hints = Table("learning_hints", metadata,
    Column("session_id", ForeignKey("learning_sessions.session_id"), primary_key=True),
    Column("qid", String(80), primary_key=True), Column("level", Integer, primary_key=True),
    Column("text", Text, nullable=False), Column("timing", Text), Column("created_at", Float, nullable=False))
_ready: set[int] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def due_concepts(revision: ProfileRevision | None, now: str | None = None) -> list[dict]:
    """Concepts worth a warm-up, most urgent first: an open misconception, low predicted retention or a shaky mean.

    Retention is 2^(−Δt/half-life) since the concept's last evidence. Shaky and misconception concepts are due
    at once, so a second session minutes after the first still opens with a review.
    """
    if revision is None:
        return []
    now = now or _now()
    flagged = {m.concept for m in revision.misconceptions if m.status in ("active", "suspected")}
    by_concept: dict[str, dict] = {}
    for b in revision.beliefs:
        kept = 2 ** (-_hours(b.last_evidence_at, now) / b.half_life_hours) if b.half_life_hours and b.last_evidence_at else 1.0
        entry = by_concept.setdefault(b.concept, {"concept": b.concept, "retention": 1.0, "mean": 1.0})
        entry["retention"], entry["mean"] = min(entry["retention"], kept), min(entry["mean"], b.mean)
    due = []
    for entry in by_concept.values():
        reason = ("misconception" if entry["concept"] in flagged else "fading" if entry["retention"] < RETAINED
                  else "shaky" if entry["mean"] < SHAKY_MEAN else None)
        if reason:
            due.append({**entry, "reason": reason, "retention": round(entry["retention"], 3), "mean": round(entry["mean"], 3)})
    due.sort(key=lambda e: (e["reason"] != "misconception", e["retention"] * e["mean"]))
    return due


class StudyStore:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine
        if id(self.engine) not in _ready:
            hints.create(self.engine, checkfirst=True)
            _ready.add(id(self.engine))

    def latest_checks(self, owner: str, sid: str) -> dict[str, dict]:
        """concept -> the check to re-ask from an earlier session (server copy, key included): the latest one the
        learner missed, else the latest one.

        Predicts are left out: they borrow a concept, so they never make one due or stand in for it."""
        latest: dict[str, dict] = {}
        missed: dict[str, dict] = {}
        with self.engine.connect() as conn:
            rows = conn.execute(select(observations.c.question_json, observations.c.verifier_json,
                                       observations.c.observation_json).where(
                observations.c.owner_id == owner, observations.c.session_id != sid)
                .order_by(observations.c.created_at.desc()).limit(500))
            for question_json, verifier_json, observation_json in rows:
                question = json.loads(question_json)
                if question.get("kind") == "predict" or not question.get("concept"):
                    continue
                concept = json.loads(verifier_json)["concept"]
                latest.setdefault(concept, question)
                outcome = json.loads(observation_json)["outcome"] if observation_json else None
                if outcome in ("incorrect", "partial", "unanswered"):
                    missed.setdefault(concept, question)
        return {**latest, **missed}

    def reviewed(self, owner: str, sid: str) -> set[str]:
        """Concepts already offered as a warm-up in this session."""
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, sid)
            rows = conn.execute(select(turns.c.input).where(turns.c.session_id == sid, turns.c.kind == "review"))
            return {json.loads(value).get("concept") for (value,) in rows}

    def session_concept(self, sid: str) -> str | None:
        """The session's main concept: the one with the most answered checks."""
        with self.engine.connect() as conn:
            rows = conn.execute(select(observations.c.verifier_json, observations.c.question_json)
                                .where(observations.c.session_id == sid))
            counted = Counter(json.loads(v)["concept"] for v, q in rows if json.loads(q).get("kind") != "predict")
        return counted.most_common(1)[0][0] if counted else None

    def hints(self, sid: str, qid: str) -> list[dict]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(hints.c.level, hints.c.text).where(hints.c.session_id == sid, hints.c.qid == qid)
                                .order_by(hints.c.level))
            return [{"level": level, "text": text} for level, text in rows]

    def keep_hint(self, sid: str, qid: str, level: int, text: str, timing: dict) -> list[dict]:
        """Insert once; a concurrent duplicate keeps the first text."""
        try:
            with self.engine.begin() as conn:
                conn.execute(insert(hints).values(session_id=sid, qid=qid, level=level, text=text,
                                                  timing=json.dumps(timing), created_at=time.time()))
        except IntegrityError:
            pass
        return self.hints(sid, qid)

    def canvases(self, owner: str) -> list[dict]:
        """The owner's saved sessions, newest first, titled by their first question."""
        with self.engine.connect() as conn:
            listed = conn.execute(select(sessions.c.session_id, sessions.c.status, sessions.c.created_at)
                                  .where(sessions.c.owner_id == owner).order_by(sessions.c.created_at.desc())
                                  .limit(CANVAS_LIMIT)).mappings().all()
            ids = [r["session_id"] for r in listed]
            titles, counts = {}, Counter()
            if ids:
                for session_id, kind, value in conn.execute(select(turns.c.session_id, turns.c.kind, turns.c.input)
                                                            .where(turns.c.session_id.in_(ids)).order_by(turns.c.seq)):
                    counts[session_id] += 1
                    if kind == "question" and session_id not in titles:
                        titles[session_id] = json.loads(value).get("text", "")[:80]
        return [{"session_id": r["session_id"], "sealed": r["status"] == "closed", "created_at": r["created_at"],
                 "title": titles.get(r["session_id"]) or "Untitled canvas", "turns": counts[r["session_id"]]}
                for r in listed]


def review_items(revision: ProfileRevision | None, checks: dict[str, dict], skip: set[str], now: str | None = None) -> list[dict]:
    """Due concepts that have a stored check to re-ask, minus those already reviewed this session."""
    out = []
    for entry in due_concepts(revision, now):
        question = checks.get(entry["concept"])
        if question and entry["concept"] not in skip:
            out.append({**entry, "q": question["q"]})
        if len(out) >= REVIEW_LIMIT:
            break
    return out


def review_moves(question: dict) -> list[dict]:
    """A warm-up turn drawn without a model call: a heading, then the stored check (key stays server-side)."""
    return [{"type": "seg", "id": "warmup", "goal": "Warm-up from last time"},
            {"type": "check", "kind": question["kind"], "q": question["q"], "key": question["key"],
             "concept": question["concept"], "dim": question["dim"], "options": question["options"]},
            {"type": "turn_end"}]


HINT_FORMAT = {"type": "json_schema", "json_schema": {"name": "hint", "strict": True, "schema": {
    "type": "object", "additionalProperties": False, "required": ["hint"],
    "properties": {"hint": {"type": "string", "description": "One or two sentences, plain text, $…$ for math"}}}}}
HINT_RULES = {
    1: "Give a NUDGE: point at the idea or the first thing to look at. Do not state the answer, the key, or "
       "anything that eliminates all but one option.",
    2: "Give a WORKED STEP: carry out the first step of the reasoning concretely, leaving the final step to the "
       "learner. Do not state the final answer or which option is correct.",
}


def hint_messages(question: dict, level: int, earlier: list[dict]) -> list[dict]:
    task = {"question": question["q"], "kind": question["kind"], "options": question["options"], "key": question["key"],
            "earlier_hints": [h["text"] for h in earlier], "level": level}
    return [{"role": "system", "content": "You are Y, a patient tutor. The learner asked for a hint on the check "
             "below. The key is for you only. " + HINT_RULES[level] + " Build on earlier hints, never repeat them. "
             'Reply as JSON {"hint": "..."}, at most 40 words.'},
            {"role": "user", "content": "CHECK\n" + json.dumps(task, ensure_ascii=False)}]


def parse_hint(content: str, question: dict) -> str:
    """The hint text, rejected if empty or if it leaks a short key verbatim."""
    try:
        text = str(json.loads(content).get("hint", "")).strip()
    except (ValueError, AttributeError):
        raise StoreError(502, "hint_invalid") from None
    key = str(question.get("key", "")).strip().lower()
    if not text or len(text) > 400:
        raise StoreError(502, "hint_invalid")
    if question["kind"] == "mcq" and len(key) >= 4 and key in text.lower():
        raise StoreError(502, "hint_leaked")
    return text
