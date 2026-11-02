"""Session-wise learner model (H5): seal a session's observations into one profile revision, then brief.

The reducer is pure and deterministic: Beta(alpha, beta) per concept × dimension, a recall
half-life, and a misconception ledger. It updates on the decision model's probabilities, not on
its top choice: a belief moves by expected credit, and a misconception accumulates the probability
mass the answers gave it (suspected below ACTIVE_AT, active above). A revision is written once per session at close
(UNIQUE(session_id)), so replaying a close never counts evidence twice. The brief for the next
session is compiled from the latest revision without any model call.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from uuid import UUID, uuid4

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
CREDIT = {"correct": 1.0, "partial": 0.5, "incorrect": 0.0, "unanswered": 0.0}
SIGHTING = 0.15  # misconception mass one answer needs to enter the ledger
ACTIVE_AT = 0.5  # accumulated mass that makes a misconception active (one confident wrong check)
RECUR_AT = 0.25  # mass in a session that counts as a recurrence and blocks resolving it
CLEAN = 0.2  # a correct answer counts toward resolving only if its own misconception mass is below this
REASONING_SEEN = 0.6  # visible-reasoning mass a concept needs before the brief mentions it
LEVELS = ((0.3, "mostly flawed"), (0.6, "mostly surface-level"), (0.9, "sound"), (1.01, "insightful"))
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
    # A soft label carries its uncertainty in `outcome_p`; older hard labels scale by their confidence.
    if observation.label_confidence is not None and observation.outcome_p is None:
        w *= observation.label_confidence
    return round(w, 6)


def credit(observation: Observation) -> float:
    """Expected credit in [0, 1]: p(correct) + ½ p(partial) from the label distribution, else the outcome's own."""
    dist = observation.outcome_p
    if dist and sum(dist.values()) > 0:
        return sum(CREDIT[k] * p for k, p in dist.items()) / sum(dist.values())
    return CREDIT[observation.outcome]


def sightings(observation: Observation, w: float) -> dict[str, float]:
    """Misconception id -> mass this answer gives it: p(misconception) × p(miss) × the answer's weight."""
    if observation.misconception_p or observation.other_misconception_p is not None:
        base = dict(observation.misconception_p)
    else:  # an older hard label
        base = {observation.misconception: 1.0} if observation.misconception else {}
    miss = 1 - credit(observation)
    return {mid: round(p * miss * w, 6) for mid, p in base.items()}


def level(score: float) -> str:
    return next(word for top, word in LEVELS if score < top)


def describe(misconception: str) -> str:
    concept, _, rest = misconception.partition("/")
    return f"On {concept}: believes {rest.replace('-', ' ')}" if rest else misconception


def reduce(previous: ProfileRevision | None, index: dict, observations: list[Observation], session_id: str,
           notes: list[TeachingNote] = (), consolidator: str | None = None, at: str | None = None,
           descriptions: dict[str, str] | None = None, named: list[dict] = ()) -> tuple[ProfileRevision, dict]:
    """(new revision, new evidence index). Pure: the same inputs always give the same revision.

    `named` holds beliefs the notes model named for flagged answers: {id, concept, description, mass,
    evidence: [observation ids]}. A named answer's mass goes to its belief, not to its option-shaped ids.
    """
    at = at or now_iso()
    beliefs = {(b.concept, b.dimension): b.model_dump() for b in (previous.beliefs if previous else ())}
    index = {key: {**value, "evidence": list(value["evidence"])} for key, value in index.items()}
    ledger = {m.id: m.model_dump() for m in (previous.misconceptions if previous else ())}
    seen_now: dict[str, float] = {}
    clean_credit: dict[str, float] = {}
    used = []
    absorbed = {str(e) for item in named for e in item["evidence"]}

    def sight(mid, concept, mass, evidence, description=None):
        if mass < SIGHTING and mid not in ledger:
            return
        entry = ledger.get(mid) or {"id": mid, "concept": concept, "status": "suspected", "strength": 0.0, "evidence": [],
                                    "description": description or (descriptions or {}).get(mid) or describe(mid)}
        strength = round(entry.get("strength", 1.0) + mass, 6)
        status = "active" if strength >= ACTIVE_AT or entry["status"] == "active" else "suspected"
        entry.update(status=status, strength=strength, evidence=[*entry["evidence"], *evidence][-32:])
        ledger[mid] = entry
        seen_now[mid] = seen_now.get(mid, 0.0) + mass

    for o in sorted(observations, key=lambda o: (o.created_at, str(o.observation_id))):
        used.append(o.observation_id)
        w, c = weight(o), credit(o)
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
            b["alpha"] += w * c
            b["beta"] += w * (1 - c)
            if c >= 0.7 and o.dimension in ("recall", "understand") and b["last_evidence_at"] and gap >= half_life / 2:
                half_life = min(MAX_HALF_LIFE, half_life * 2)
            elif c <= 0.3 and o.outcome != "unanswered":
                half_life = max(MIN_HALF_LIFE, half_life / 2)
            b.update(alpha=round(b["alpha"], 6), beta=round(b["beta"], 6), half_life_hours=round(half_life, 4),
                     last_evidence_at=o.created_at)
            beliefs[key] = b
            slot = index.setdefault(f"{o.concept}|{o.dimension}", {"evidence": [], "right": 0, "total": 0})
            slot["evidence"] = (slot["evidence"] + [str(o.observation_id)])[-EVIDENCE_KEPT:]
            slot["total"] += 1
            slot["right"] = round(slot["right"] + c, 4)
        found = sightings(o, w)
        for mid, mass in found.items():
            if str(o.observation_id) not in absorbed:
                sight(mid, o.concept, mass, [o.observation_id])
        if w > 0 and sum(found.values()) < CLEAN:
            clean_credit[o.concept] = clean_credit.get(o.concept, 0.0) + c
        if o.reasoning is not None and o.reasoning_shown:
            slot = index.setdefault(f"reasoning|{o.concept}", {"evidence": [], "score": 0.0, "seen": 0.0})
            slot["evidence"] = (slot["evidence"] + [str(o.observation_id)])[-EVIDENCE_KEPT:]
            slot["score"] = round(slot["score"] + o.reasoning * o.reasoning_shown, 4)
            slot["seen"] = round(slot["seen"] + o.reasoning_shown, 4)
    for item in sorted(named, key=lambda n: n["id"]):
        sight(item["id"], item["concept"], item["mass"], [UUID(str(e)) for e in item["evidence"]], item["description"])
    for mid, entry in ledger.items():
        if entry["status"] != "resolved" and seen_now.get(mid, 0.0) < RECUR_AT \
                and clean_credit.get(entry["concept"], 0.0) >= RESOLVE_AFTER:
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
        if m.status != "resolved":
            text = m.description if m.status == "active" else f"Possibly (not yet confirmed): {m.description}"
            candidates.append((0 if m.status == "active" else 1, "misconception", m.concept, text,
                               [str(e) for e in m.evidence[-EVIDENCE_KEPT:]]))
    for b in revision.beliefs:
        slot = index.get(f"{b.concept}|{b.dimension}")
        if not slot or not slot["total"]:
            continue
        right = slot["right"]
        record = f"{right:g} of {slot['total']} right" if abs(right - round(right)) < 0.05 else \
            f"about {right:.1f} of {slot['total']} right"
        due = b.half_life_hours and _hours(b.last_evidence_at, now) > b.half_life_hours
        if b.mean >= KNOWN and not due:
            candidates.append((2, "known", b.concept, f"Knows {b.concept} ({b.dimension}): {record}.", slot["evidence"]))
        elif b.mean >= SHAKY:
            reason = "due for review" if due and b.mean >= KNOWN else "shaky"
            candidates.append((1, "shaky", b.concept, f"{b.concept} ({b.dimension}) is {reason}: {record}.", slot["evidence"]))
        else:
            candidates.append((1, "shaky", b.concept, f"Struggled with {b.concept} ({b.dimension}): {record}.", slot["evidence"]))
    for key, slot in sorted(index.items()):
        if key.startswith("reasoning|") and slot["seen"] >= REASONING_SEEN:
            concept, score = key.partition("|")[2], slot["score"] / slot["seen"]
            text = f"Reasoning on {concept} is {level(score)} (score {score:.2f} over {slot['seen']:.1f} explained answers)."
            if score < 0.6:
                text += " Ask them to explain why, not only what."
            candidates.append((2 if score >= 0.7 else 1, "known" if score >= 0.7 else "shaky", concept, text, slot["evidence"]))
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
