"""Session-wise learner model (H5): seal a session's observations into one profile revision, then brief.

The reducer is pure and deterministic: Beta(alpha, beta) per concept × dimension, a recall
half-life, and a misconception ledger. A revision is written once per session at close
(UNIQUE(session_id)), so replaying a close never counts evidence twice. The brief for the next
session is compiled from the latest revision without any model call.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (Column, Float, ForeignKey, Integer, String, Table, Text, UniqueConstraint, insert, select,
                        update)
from sqlalchemy.exc import IntegrityError

from .contracts import canonical, now_iso
from .learner_contracts import (BRIEF_MAX_CHARS, Belief, BriefItem, LearnerBrief, MisconceptionEntry, Observation,
                                ProfileRevision, TeachingNote)
from .storage import CaptureStore, StoreError, metadata, sessions

PRIOR = 1.0
FIRST_HALF_LIFE, MIN_HALF_LIFE, MAX_HALF_LIFE = 24.0, 4.0, 24.0 * 180
HINT_FACTOR, SUSPECT_FACTOR = 0.7, 0.5
KNOWN, SHAKY = 0.7, 0.35
RESOLVE_AFTER = 2  # later correct answers on a concept, with no recurrence, resolve its misconception
EVIDENCE_KEPT = 8
CLOSE_STALE_SECONDS = 120

revisions = Table("learning_profile_revisions", metadata,
    Column("owner_id", ForeignKey("learning_identities.owner_id"), nullable=False),
    Column("revision", Integer, nullable=False),
    Column("session_id", ForeignKey("learning_sessions.session_id"), nullable=False, unique=True),
    Column("revision_json", Text, nullable=False),
    # Per concept × dimension: recent evidence ids and counts, which the brief cites.
    Column("index_json", Text, nullable=False),
    Column("close_json", Text, nullable=False),
    Column("created_at", Float, nullable=False),
    UniqueConstraint("owner_id", "revision", name="learning_profile_revision_once"))
session_memory = Table("learning_session_memory", metadata,
    Column("session_id", ForeignKey("learning_sessions.session_id"), primary_key=True),
    Column("memory", Integer, nullable=False, default=1),
    Column("brief_json", Text),
    Column("closing_at", Float, nullable=False, default=0))
_ready: set[int] = set()


# ---------------------------------------------------------------------------------------------
# Reducer


def _hours(earlier: str | None, later: str) -> float:
    if not earlier:
        return 0.0
    a = datetime.fromisoformat(earlier.replace("Z", "+00:00"))
    b = datetime.fromisoformat(later.replace("Z", "+00:00"))
    return max(0.0, (b - a).total_seconds() / 3600)


def weight(observation: Observation) -> float:
    """How much one answer moves a belief: format × key trust × independence × label confidence."""
    if observation.key_status == "wrong":
        return 0.0
    w = observation.format_weight
    if observation.key_status == "suspect":
        w *= SUSPECT_FACTOR
    if observation.assistance.hint_ids or observation.assistance.self_reported_help:
        w *= HINT_FACTOR
    if observation.label_confidence is not None:
        w *= observation.label_confidence
    return round(w, 6)


def describe(misconception: str) -> str:
    concept, _, rest = misconception.partition("/")
    return f"On {concept}: believes {rest.replace('-', ' ')}" if rest else misconception


def reduce(previous: ProfileRevision | None, index: dict, observations: list[Observation], session_id: str,
           notes: list[TeachingNote] = (), consolidator: str | None = None, at: str | None = None,
           descriptions: dict[str, str] | None = None) -> tuple[ProfileRevision, dict]:
    """(new revision, new evidence index). Pure: the same inputs always give the same revision."""
    at = at or now_iso()
    beliefs = {(b.concept, b.dimension): b.model_dump() for b in (previous.beliefs if previous else ())}
    index = {key: {**value, "evidence": list(value["evidence"])} for key, value in index.items()}
    ledger = {m.id: m.model_dump() for m in (previous.misconceptions if previous else ())}
    seen_now: set[str] = set()
    correct_after: dict[str, int] = {}
    used = []
    for o in sorted(observations, key=lambda o: (o.created_at, str(o.observation_id))):
        used.append(o.observation_id)
        w = weight(o)
        if w > 0:
            key = (o.concept, o.dimension)
            b = beliefs.get(key) or {"concept": o.concept, "dimension": o.dimension, "alpha": PRIOR, "beta": PRIOR,
                                     "half_life_hours": FIRST_HALF_LIFE, "last_evidence_at": None}
            gap = _hours(b["last_evidence_at"], o.created_at)
            half_life = b["half_life_hours"] or FIRST_HALF_LIFE
            if gap:
                keep = 2 ** (-gap / half_life)
                b["alpha"] = PRIOR + (b["alpha"] - PRIOR) * keep
                b["beta"] = PRIOR + (b["beta"] - PRIOR) * keep
            if o.outcome == "correct":
                b["alpha"] += w
                if o.dimension in ("recall", "understand") and b["last_evidence_at"] and gap >= half_life / 2:
                    half_life = min(MAX_HALF_LIFE, half_life * 2)
            elif o.outcome == "partial":
                b["alpha"] += w / 2
                b["beta"] += w / 2
            else:
                b["beta"] += w
                if o.outcome == "incorrect":
                    half_life = max(MIN_HALF_LIFE, half_life / 2)
            b.update(alpha=round(b["alpha"], 6), beta=round(b["beta"], 6), half_life_hours=round(half_life, 4),
                     last_evidence_at=o.created_at)
            beliefs[key] = b
            slot = index.setdefault(f"{o.concept}|{o.dimension}", {"evidence": [], "right": 0, "total": 0})
            slot["evidence"] = (slot["evidence"] + [str(o.observation_id)])[-EVIDENCE_KEPT:]
            slot["total"] += 1
            slot["right"] += o.outcome == "correct"
        if o.misconception:
            seen_now.add(o.misconception)
            entry = ledger.get(o.misconception) or {"id": o.misconception, "concept": o.concept,
                                                    "description": (descriptions or {}).get(o.misconception) or describe(o.misconception),
                                                    "evidence": []}
            entry.update(status="active", evidence=[*entry["evidence"], o.observation_id][-32:])
            ledger[o.misconception] = entry
        elif o.outcome == "correct" and w > 0:
            correct_after[o.concept] = correct_after.get(o.concept, 0) + 1
    for mid, entry in ledger.items():
        if entry["status"] == "active" and mid not in seen_now and correct_after.get(entry["concept"], 0) >= RESOLVE_AFTER:
            entry["status"] = "resolved"
    number = (previous.revision + 1) if previous else 1
    revision = ProfileRevision(
        revision=number, parent_revision=previous.revision if previous else None, session_id=session_id,
        observation_ids=tuple(used), beliefs=tuple(Belief(**b) for _, b in sorted(beliefs.items())),
        misconceptions=tuple(MisconceptionEntry(**m) for _, m in sorted(ledger.items())), notes=tuple(notes),
        consolidator=consolidator, created_at=at)
    return revision, index


# ---------------------------------------------------------------------------------------------
# Brief


def _words(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", text.casefold()) if len(w) > 2}


def compile_brief(revision: ProfileRevision | None, index: dict, topic: str, now: str | None = None) -> LearnerBrief | None:
    """A bounded brief for this topic: misconceptions, shaky and known ideas, notes; each item cites evidence."""
    if revision is None:
        return None
    now = now or now_iso()
    asked = _words(topic)
    candidates = []  # (rank, kind, concept, text, evidence)
    for m in revision.misconceptions:
        if m.status == "active":
            candidates.append((0, "misconception", m.concept, m.description, [str(e) for e in m.evidence[-EVIDENCE_KEPT:]]))
    for b in revision.beliefs:
        slot = index.get(f"{b.concept}|{b.dimension}")
        if not slot or not slot["total"]:
            continue
        record = f"{slot['right']} of {slot['total']} right"
        due = b.half_life_hours and _hours(b.last_evidence_at, now) > b.half_life_hours
        if b.mean >= KNOWN and not due:
            candidates.append((2, "known", b.concept, f"Knows {b.concept} ({b.dimension}): {record}.", slot["evidence"]))
        elif b.mean >= SHAKY:
            reason = "due for review" if due and b.mean >= KNOWN else "shaky"
            candidates.append((1, "shaky", b.concept, f"{b.concept} ({b.dimension}) is {reason}: {record}.", slot["evidence"]))
        else:
            candidates.append((1, "shaky", b.concept, f"Struggled with {b.concept} ({b.dimension}): {record}.", slot["evidence"]))
    for note in revision.notes:
        candidates.append((3, "note", None, note.text, [str(c) for c in note.cites]))
    # Concepts that share words with the question come first, then by kind.
    candidates.sort(key=lambda c: (0 if _words(c[2] or c[3]) & asked else 1, c[0]))
    prefix = {"known": "K", "shaky": "S", "misconception": "M", "note": "N"}
    counts: dict[str, int] = {}
    items, used = [], 0
    for _rank, kind, concept, text, evidence in candidates:
        text = text[:280]
        if len(items) >= 24 or used + len(text) > BRIEF_MAX_CHARS or not evidence:
            continue
        counts[kind] = counts.get(kind, 0) + 1
        items.append(BriefItem(id=f"{prefix[kind]}{counts[kind]}", kind=kind, concept=concept, text=text,
                               evidence=tuple(evidence[-EVIDENCE_KEPT:])))
        used += len(text)
    if not items:
        return None
    return LearnerBrief(brief_id=uuid4(), topic=topic[:160] or "general", profile_revision=revision.revision,
                        items=tuple(items))


def render_brief(brief: LearnerBrief | None) -> str:
    """The text the tutor reads; `because` moves cite these ids."""
    if brief is None:
        return ""
    lines = [f"From earlier sessions (profile revision {brief.profile_revision}). Cite ids in `because`."]
    lines += [f"{item.id} [{item.kind}] {item.text}" for item in brief.items]
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------
# Storage


class ProfileStore:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine
        if id(self.engine) not in _ready:
            revisions.create(self.engine, checkfirst=True)
            session_memory.create(self.engine, checkfirst=True)
            _ready.add(id(self.engine))

    def latest(self, owner: str) -> tuple[ProfileRevision | None, dict]:
        with self.engine.connect() as conn:
            row = conn.execute(select(revisions).where(revisions.c.owner_id == owner).order_by(revisions.c.revision.desc()).limit(1)).mappings().first()
        if row is None:
            return None, {}
        return ProfileRevision.model_validate_json(row["revision_json"]), json.loads(row["index_json"])

    def for_session(self, owner: str, sid: str) -> dict | None:
        with self.engine.connect() as conn:
            row = conn.execute(select(revisions).where(revisions.c.session_id == sid,
                                                       revisions.c.owner_id == owner)).mappings().first()
        return None if row is None else {"revision": ProfileRevision.model_validate_json(row["revision_json"]),
                                         "close": json.loads(row["close_json"])}

    def _memory_row(self, conn, sid: str):
        row = conn.execute(select(session_memory).where(session_memory.c.session_id == sid)).mappings().first()
        if row is None:
            try:
                with conn.begin_nested():
                    conn.execute(insert(session_memory).values(session_id=sid, memory=1, closing_at=0))
            except IntegrityError:
                pass
            row = conn.execute(select(session_memory).where(session_memory.c.session_id == sid)).mappings().first()
        return row

    def memory(self, owner: str, sid: str) -> dict:
        with self.engine.begin() as conn:
            session = self.capture._session(conn, owner, sid)
            row = self._memory_row(conn, sid)
        return {"memory": bool(row["memory"]), "status": session["status"],
                "brief": json.loads(row["brief_json"]) if row["brief_json"] else None}

    def set_memory(self, owner: str, sid: str, on: bool) -> dict:
        with self.engine.begin() as conn:
            self.capture._session(conn, owner, sid)
            self._memory_row(conn, sid)
            conn.execute(update(session_memory).where(session_memory.c.session_id == sid).values(memory=int(on)))
        return self.memory(owner, sid)

    def keep_brief(self, sid: str, brief: LearnerBrief) -> None:
        """The first brief of a session stands for the rest of it; a concurrent first turn keeps the earlier one."""
        with self.engine.begin() as conn:
            conn.execute(update(session_memory).where(session_memory.c.session_id == sid,
                                                      session_memory.c.brief_json.is_(None))
                         .values(brief_json=canonical(brief)))

    def begin_close(self, owner: str, sid: str) -> str:
        """'closed' (already sealed), or 'claimed' for this caller; a close in progress is a 409."""
        now = time.time()
        with self.engine.begin() as conn:
            session = self.capture._session(conn, owner, sid)
            if session["status"] == "closed" or conn.execute(
                    select(revisions.c.session_id).where(revisions.c.session_id == sid)).first():
                return "closed"
            row = self._memory_row(conn, sid)
            if session["status"] == "closing" and row["closing_at"] > now - CLOSE_STALE_SECONDS:
                raise StoreError(409, "session_closing")
            conn.execute(update(sessions).where(sessions.c.session_id == sid).values(status="closing"))
            conn.execute(update(session_memory).where(session_memory.c.session_id == sid).values(closing_at=now))
        return "claimed"

    def finish_empty(self, sid: str) -> None:
        """A session with no evidence closes without a revision; profile_updated stays false."""
        with self.engine.begin() as conn:
            conn.execute(update(sessions).where(sessions.c.session_id == sid).values(status="closed"))

    def abort_close(self, sid: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(sessions).where(sessions.c.session_id == sid, sessions.c.status == "closing")
                         .values(status="open"))

    def write(self, owner: str, sid: str, build) -> tuple[ProfileRevision, dict, bool]:
        """Reduce against the owner's latest revision and insert once; `build(previous, index)` -> (revision, index, close).
        Returns (revision, close summary, replayed)."""
        for _ in range(3):
            previous, index = self.latest(owner)
            revision, new_index, close = build(previous, index)
            try:
                with self.engine.begin() as conn:
                    conn.execute(insert(revisions).values(
                        owner_id=owner, revision=revision.revision, session_id=sid, revision_json=canonical(revision),
                        index_json=canonical(new_index), close_json=canonical(close), created_at=time.time()))
                    conn.execute(update(sessions).where(sessions.c.session_id == sid).values(status="closed"))
                return revision, close, False
            except IntegrityError:
                stored = self.for_session(owner, sid)
                if stored is not None:
                    return stored["revision"], stored["close"], True
                # Another session of this owner took the revision number: reduce again on top of it.
        raise StoreError(409, "profile_revision_conflict")
