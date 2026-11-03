"""Transactional capture storage. SQLite for local development; Postgres for deployment.

The repository opens short transactions and never holds one over model inference.
Conditional writes and unique constraints coordinate independent API instances.
"""
from __future__ import annotations

import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import (Column, Float, ForeignKey, Index, Integer, MetaData, String,
                        Table, Text, UniqueConstraint, create_engine, event, insert, select, update, func)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from .contracts import Assessment, AttemptInput, CapturedAttempt, SourceRef, TaskSpec, canonical, digest, now_iso

metadata = MetaData()


def limit(name: str, default: int) -> int:
    """A budget cap, overridable per deployment with Y_LIMIT_<NAME> (production tightens paid calls)."""
    raw = os.environ.get(f"Y_LIMIT_{name}", "").strip()
    return int(raw) if raw.isdigit() else default


identities = Table("learning_identities", metadata,
    Column("owner_id", String(36), primary_key=True),
    Column("token_hash", String(64), nullable=False, unique=True),
    Column("expires_at", Float, nullable=False))
sessions = Table("learning_sessions", metadata,
    Column("session_id", String(36), primary_key=True),
    Column("owner_id", ForeignKey("learning_identities.owner_id"), nullable=False, index=True),
    Column("revision", Integer, nullable=False, default=0),
    Column("status", String(16), nullable=False, default="open"),
    Column("created_at", Float, nullable=False))
attempts = Table("learning_attempts", metadata,
    Column("attempt_id", String(36), primary_key=True),
    Column("session_id", ForeignKey("learning_sessions.session_id"), nullable=False),
    Column("owner_id", ForeignKey("learning_identities.owner_id"), nullable=False),
    Column("request_hash", String(64), nullable=False),
    Column("capture_json", Text, nullable=False),
    Column("state", String(16), nullable=False),
    Column("lease_token", String(64)), Column("lease_until", Float, nullable=False, default=0),
    Column("run_count", Integer, nullable=False, default=0),
    Column("latest_json", Text), Column("created_at", Float, nullable=False))
Index("learning_attempt_owner_session", attempts.c.owner_id, attempts.c.session_id, attempts.c.created_at)
evaluations = Table("learning_evaluations", metadata,
    Column("assessment_id", String(36), primary_key=True),
    Column("attempt_id", ForeignKey("learning_attempts.attempt_id"), nullable=False, index=True),
    Column("result_json", Text, nullable=False))
budgets = Table("learning_budgets", metadata,
    Column("bucket", String(100), primary_key=True), Column("used", Integer, nullable=False))
# One row per answered tutor predict/check (H4). UNIQUE(session_id, qid): a repeat never double-counts.
observations = Table("learning_observations", metadata,
    Column("observation_id", String(36), primary_key=True),
    Column("session_id", ForeignKey("learning_sessions.session_id"), nullable=False),
    Column("owner_id", ForeignKey("learning_identities.owner_id"), nullable=False),
    Column("qid", String(80), nullable=False), Column("turn_id", String(36), nullable=False),
    Column("status", String(16), nullable=False), Column("modality", String(8), nullable=False),
    # The question snapshot holds the tutor's key; it is labeler context, never a learner source.
    Column("question_json", Text, nullable=False), Column("answer_text", Text, nullable=False),
    Column("verifier_json", Text, nullable=False), Column("label_json", Text), Column("observation_json", Text),
    Column("key_status", String(8), nullable=False, default="ok"), Column("error", String(64)),
    Column("duplicates", Integer, nullable=False, default=0), Column("label_ms", Float),
    Column("lease_until", Float, nullable=False, default=0), Column("created_at", Float, nullable=False),
    UniqueConstraint("session_id", "qid", name="learning_observation_once"))


@dataclass
class StoreError(Exception):
    status: int
    code: str


def make_engine(url: str) -> Engine:
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 10})

        @event.listens_for(engine, "connect")
        def configure_sqlite(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
    elif url.startswith("postgresql+psycopg://"):
        # Production raises the pool (Y_LIMIT_DB_POOL) so 16 concurrent inputs per container do not queue on it.
        engine = create_engine(url, pool_pre_ping=True, pool_size=limit("DB_POOL", 3), max_overflow=limit("DB_OVERFLOW", 2),
                               pool_timeout=10, pool_recycle=240, connect_args={"connect_timeout": 5})
    else:
        raise ValueError("learning storage supports SQLite or Postgres")
    return engine


def local_database_url() -> str:
    directory = Path(__file__).resolve().parents[1] / "data"
    directory.mkdir(exist_ok=True)
    return "sqlite:///" + (directory / "learning.sqlite3").as_posix()


class CaptureStore:
    def __init__(self, engine: Engine):
        self.engine = engine

    def initialize(self) -> None:
        """Idempotent v1 -> v2 additive upgrade; safe for existing typed captures."""
        from .board_storage import upgrade
        upgrade(self.engine)

    def issue_identity(self) -> str:
        token = secrets.token_urlsafe(32)
        with self.engine.begin() as conn:
            conn.execute(insert(identities).values(owner_id=str(uuid4()), token_hash=digest(token),
                                                  expires_at=time.time() + 30 * 86400))
        return token

    def owner_for_token(self, token: str) -> str | None:
        if not token or len(token) > 100:
            return None
        with self.engine.connect() as conn:
            return conn.scalar(select(identities.c.owner_id).where(
                identities.c.token_hash == digest(token), identities.c.expires_at > time.time()))

    @staticmethod
    def _session(conn, owner: str, session_id: str):
        row = conn.execute(select(sessions).where(sessions.c.session_id == session_id,
                                                 sessions.c.owner_id == owner)).mappings().first()
        if row is None:
            raise StoreError(404, "session_not_found")
        return row

    def create_session(self, owner: str, session_id: UUID) -> dict:
        sid = str(session_id)
        try:
            with self.engine.begin() as conn:
                conn.execute(insert(sessions).values(session_id=sid, owner_id=owner, revision=0,
                                                     status="open", created_at=time.time()))
        except IntegrityError:
            # A repeated create succeeds only for the original owner.
            pass
        return self.get_session(owner, session_id)

    def get_session(self, owner: str, session_id: UUID) -> dict:
        with self.engine.connect() as conn:
            row = self._session(conn, owner, str(session_id))
            return {"session_id": row["session_id"], "revision": row["revision"],
                    "status": row["status"], "profile_revision": 0}

    def capture(self, owner: str, session_id: UUID, attempt: AttemptInput, task: TaskSpec) -> dict:
        sid, aid = str(session_id), str(attempt.attempt_id)
        request_hash = digest(canonical({"session_id": sid, "attempt": attempt.model_dump(mode="json")}))
        captured = CapturedAttempt(
            owner_id=owner, session_id=session_id, attempt=attempt, task=task,
            source=SourceRef(event_id=uuid4(), content_hash=digest(attempt.text), start=0, end=len(attempt.text)),
            captured_at=now_iso(),
        )
        try:
            with self.engine.begin() as conn:
                self._session(conn, owner, sid)
                # Lock/update the session before checking its cap: concurrent captures serialize.
                changed = conn.execute(update(sessions).where(
                    sessions.c.session_id == sid, sessions.c.owner_id == owner, sessions.c.status == "open"
                ).values(revision=sessions.c.revision + 1))
                if changed.rowcount != 1:
                    raise StoreError(409, "session_closed")
                previous = conn.execute(select(attempts).where(attempts.c.attempt_id == aid)).mappings().first()
                if previous:
                    raise StoreError(409, "existing_attempt")
                count = conn.scalar(select(func.count()).select_from(attempts).where(attempts.c.session_id == sid))
                if count >= 100:
                    raise StoreError(429, "session_attempt_limit")
                conn.execute(insert(attempts).values(
                    attempt_id=aid, session_id=sid, owner_id=owner, request_hash=request_hash,
                    capture_json=canonical(captured), state="captured", lease_until=0, run_count=0,
                    created_at=time.time(),
                ))
        except (IntegrityError, StoreError) as exc:
            if isinstance(exc, StoreError) and exc.code != "existing_attempt":
                raise
            with self.engine.connect() as conn:
                previous = conn.execute(select(attempts).where(attempts.c.attempt_id == aid,
                                                               attempts.c.owner_id == owner)).mappings().first()
                if previous is None:
                    raise StoreError(404, "attempt_not_found") from exc
                if previous["request_hash"] != request_hash:
                    raise StoreError(409, "attempt_id_reused_with_different_content") from exc
        return self.get_attempt(owner, attempt.attempt_id)

    @staticmethod
    def _attempt(conn, owner: str, attempt_id: str):
        row = conn.execute(select(attempts).where(attempts.c.attempt_id == attempt_id,
                                                 attempts.c.owner_id == owner)).mappings().first()
        if row is None:
            raise StoreError(404, "attempt_not_found")
        return row

    @staticmethod
    def _view(row) -> dict:
        capture = CapturedAttempt.model_validate_json(row["capture_json"])
        latest = Assessment.model_validate_json(row["latest_json"]) if row["latest_json"] else None
        # The owner's source text and normalized assessment are inspectable; internal rubric stays server-side.
        return {"attempt_id": row["attempt_id"], "session_id": row["session_id"], "state": row["state"],
                "retry_allowed": row["state"] != "assessed" and row["run_count"] < 3,
                "task_id": capture.attempt.task_id, "text": capture.attempt.text,
                "assistance": capture.attempt.assistance.model_dump(mode="json"),
                "source": capture.source.model_dump(mode="json"), "captured_at": capture.captured_at,
                "assessment": latest.model_dump(mode="json", exclude={"raw_result"}) if latest else None}

    def get_attempt(self, owner: str, attempt_id: UUID) -> dict:
        with self.engine.connect() as conn:
            return self._view(self._attempt(conn, owner, str(attempt_id)))

    def list_attempts(self, owner: str, session_id: UUID) -> list[dict]:
        with self.engine.connect() as conn:
            self._session(conn, owner, str(session_id))
            rows = conn.execute(select(attempts).where(attempts.c.owner_id == owner,
                attempts.c.session_id == str(session_id)).order_by(attempts.c.created_at)).mappings()
            return [self._view(row) for row in rows]

    def _spend(self, conn, bucket: str, limit: int, code: str = "assessment_budget_exhausted") -> None:
        if conn.dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as upsert
        else:
            from sqlalchemy.dialects.sqlite import insert as upsert
        conn.execute(upsert(budgets).values(bucket=bucket, used=0).on_conflict_do_nothing())
        changed = conn.execute(update(budgets).where(budgets.c.bucket == bucket, budgets.c.used < limit)
                               .values(used=budgets.c.used + 1))
        if changed.rowcount != 1:
            raise StoreError(429, code)

    def charge(self, kind: str, owner: str, per_owner: int, per_global: int) -> None:
        """Charge one call to the hourly per-owner and global buckets of `kind`; 429 `<kind>_budget_exhausted` past either."""
        hour = int(time.time() // 3600)
        with self.engine.begin() as conn:
            self._spend(conn, f"{kind}-global:{hour}", per_global, f"{kind}_budget_exhausted")
            self._spend(conn, f"{kind}-{owner}:{hour}", per_owner, f"{kind}_budget_exhausted")

    def claim(self, owner: str, attempt_id: UUID, reserve_budget: bool = True) -> tuple[str, CapturedAttempt] | None:
        aid, now, token = str(attempt_id), time.time(), secrets.token_hex(16)
        with self.engine.begin() as conn:
            row = self._attempt(conn, owner, aid)
            if row["state"] == "assessed":
                return None
            if not reserve_budget and row["latest_json"]:
                latest = Assessment.model_validate_json(row["latest_json"])
                if latest.provider_error == "provider_not_configured":
                    return None
            if row["run_count"] >= 3:
                raise StoreError(409, "assessment_retry_limit")
            changed = conn.execute(update(attempts).where(
                attempts.c.attempt_id == aid, attempts.c.owner_id == owner,
                attempts.c.state != "assessed", attempts.c.lease_until <= now, attempts.c.run_count < 3,
            ).values(state="assessing", lease_token=token, lease_until=now + 30, run_count=attempts.c.run_count + 1))
            if changed.rowcount != 1:
                raise StoreError(409, "assessment_in_progress")
            # Shared across containers; a rolled-back claim also rolls back reservations.
            hour = int(now // 3600)
            if reserve_budget:
                self._spend(conn, f"global:{hour}", 120)
                self._spend(conn, f"{owner}:{hour}", 20)
            return token, CapturedAttempt.model_validate_json(row["capture_json"])

    def complete(self, owner: str, attempt_id: UUID, token: str, result: Assessment) -> dict:
        if result.attempt_id != attempt_id:
            raise ValueError("assessment attempt mismatch")
        with self.engine.begin() as conn:
            changed = conn.execute(update(attempts).where(
                attempts.c.attempt_id == str(attempt_id), attempts.c.owner_id == owner,
                attempts.c.lease_token == token, attempts.c.lease_until > time.time(),
            ).values(state="captured" if result.provider_error else "assessed",
                     run_count=attempts.c.run_count - (1 if result.provider_error == "provider_not_configured" else 0),
                     latest_json=canonical(result), lease_token=None, lease_until=0))
            if changed.rowcount != 1:
                raise StoreError(409, "assessment_lease_lost")
            conn.execute(insert(evaluations).values(assessment_id=str(result.assessment_id),
                         attempt_id=str(attempt_id), result_json=canonical(result)))
        return self.get_attempt(owner, attempt_id)
