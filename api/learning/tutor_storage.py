"""Tutor turns: one row per turn holds the learner input, accepted moves and the waiting question.

A turn is claimed before any paid call, so a repeated turn ID replays stored moves instead of
calling the provider again. One turn streams per session at a time; leases expire if a process dies.
"""
from __future__ import annotations

import json
import time

from sqlalchemy import Column, Float, ForeignKey, Integer, String, Table, Text, func, insert, select, update
from sqlalchemy.exc import IntegrityError

from .contracts import canonical
from .storage import CaptureStore, StoreError, metadata, sessions

LEASE_SECONDS = 150
TURN_LIMIT = 400  # per session
HOURLY_TURNS, HOURLY_TURNS_GLOBAL = 60, 600

turns = Table("learning_tutor_turns", metadata,
    Column("turn_id", String(36), primary_key=True),
    Column("session_id", ForeignKey("learning_sessions.session_id"), nullable=False, index=True),
    Column("seq", Integer, nullable=False), Column("kind", String(16), nullable=False),
    Column("request_hash", String(64), nullable=False), Column("input", Text, nullable=False),
    Column("status", String(16), nullable=False), Column("moves", Text, nullable=False, default="[]"),
    Column("question", Text), Column("outcome", Text), Column("timing", Text),
    Column("lease_until", Float, nullable=False), Column("created_at", Float, nullable=False))
_ready: set[int] = set()


class TutorStore:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine
        if id(self.engine) not in _ready:
            turns.create(self.engine, checkfirst=True)
            _ready.add(id(self.engine))

    @staticmethod
    def view(row) -> dict:
        return {"turn_id": row["turn_id"], "seq": row["seq"], "kind": row["kind"], "status": row["status"],
                "input": json.loads(row["input"]), "moves": json.loads(row["moves"]),
                "question": json.loads(row["question"]) if row["question"] else None,
                "outcome": json.loads(row["outcome"]) if row["outcome"] else None,
                "timing": json.loads(row["timing"]) if row["timing"] else None}

    def begin(self, owner: str, sid: str, turn_id: str, kind: str, value: dict, request_hash: str) -> dict | None:
        """Claim a new turn (returns None) or return the finished turn with this ID for replay."""
        now = time.time()
        with self.engine.begin() as conn:
            self.capture._session(conn, owner, sid)
            # Updating the session row serializes concurrent turn claims across instances.
            conn.execute(update(sessions).where(sessions.c.session_id == sid).values(revision=sessions.c.revision))
            prior = conn.execute(select(turns).where(turns.c.turn_id == turn_id)).mappings().first()
            if prior is not None:
                if prior["session_id"] != sid or prior["request_hash"] != request_hash:
                    raise StoreError(409, "tutor_turn_reused")
                if prior["status"] == "streaming" and prior["lease_until"] > now:
                    raise StoreError(409, "tutor_turn_in_progress")
                return self.view(prior)
            busy = conn.scalar(select(func.count()).select_from(turns).where(
                turns.c.session_id == sid, turns.c.status == "streaming", turns.c.lease_until > now))
            if busy:
                raise StoreError(409, "tutor_turn_in_progress")
            seq = conn.scalar(select(func.count()).select_from(turns).where(turns.c.session_id == sid)) or 0
            if seq >= TURN_LIMIT:
                raise StoreError(429, "tutor_turn_limit")
            try:
                with conn.begin_nested():
                    conn.execute(insert(turns).values(turn_id=turn_id, session_id=sid, seq=seq + 1, kind=kind,
                        request_hash=request_hash, input=canonical(value), status="streaming", moves="[]",
                        lease_until=now + LEASE_SECONDS, created_at=now))
            except IntegrityError:
                raise StoreError(409, "tutor_turn_in_progress") from None
        return None

    def finish(self, turn_id: str, status: str, moves: list[dict], question: dict | None,
               outcome: dict | None, timing: dict) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(turns).where(turns.c.turn_id == turn_id, turns.c.status == "streaming").values(
                status=status, moves=json.dumps(moves, separators=(",", ":"), ensure_ascii=False), question=canonical(question) if question else None,
                outcome=canonical(outcome) if outcome else None, timing=canonical(timing), lease_until=0))

    def history(self, owner: str, sid: str) -> list[dict]:
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, sid)
            rows = conn.execute(select(turns).where(turns.c.session_id == sid).order_by(turns.c.seq)).mappings()
            return [self.view(row) for row in rows]

    def reserve(self, owner: str) -> None:
        with self.engine.begin() as conn:
            hour = int(time.time() // 3600)
            self.capture._spend(conn, f"tutor-global:{hour}", HOURLY_TURNS_GLOBAL)
            self.capture._spend(conn, f"tutor-{owner}:{hour}", HOURLY_TURNS)


def open_question(history: list[dict]) -> dict | None:
    """The question of the latest turn if that turn is waiting; any later turn that drew something closes it."""
    last = next((t for t in reversed(history) if t["status"] != "failed" and (t["moves"] or t["status"] != "stopped")), None)
    return last["question"] if last and last["status"] == "waiting" else None
