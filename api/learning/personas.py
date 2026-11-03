"""Demo personas: authored learners judges can try, each a private copy under the viewer's own identity.

A persona is built from `fixtures/personas/<key>.json` through the real pipeline: each answered check is
captured by `ObservationStore.capture_answer` (verifier, key audit, dedupe), finished with the fixture's
soft label as labeler "seed", and each session is sealed with the close route's own steps (`begin_close`,
`sealed`, `keep_cited` / `keep_links`, `profile.reduce`, `ProfileStore.write`). Times are backdated, so
decay, half-lives and due reviews come from the reducer. Teaching notes and model-written links were
recorded once from Muse Spark 1.3 (`scripts/record_persona_notes.py`) into `<key>.notes.json`.

IDs are uuid5 of the owner, so a rebuild into the same owner is a no-op. A copy is the same build into a
fresh owner the viewer holds; `require_owner` resolves the viewer's active persona to that copy, so every
existing route and ownership check runs unchanged and nobody can reach another viewer's copy or a template.
"""
from __future__ import annotations

import json
import logging
import secrets
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import Column, Float, ForeignKey, String, Table, create_engine, delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import StaticPool

from . import board_storage, image_jobs, observations, profile, study, tutor_storage
from .consolidate import keep_cited, keep_links
from .contracts import canonical, digest
from .storage import CaptureStore, StoreError, attempts, evaluations, identities, metadata, sessions

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "personas"
KEYS = ("priya", "tomas", "amara")
SEED = "seed"
CHECK_SPACING = 150.0  # seconds between seeded answers in a session
HOURLY_BUILDS, HOURLY_BUILDS_GLOBAL = 20, 300
OUTCOME_P = {"correct": {"correct": 0.9, "partial": 0.07, "incorrect": 0.03},
             "partial": {"partial": 0.7, "correct": 0.1, "incorrect": 0.2},
             "incorrect": {"incorrect": 0.85, "partial": 0.12, "correct": 0.03}}

copies = Table("learning_persona_copies", metadata,
    Column("viewer_owner_id", ForeignKey("learning_identities.owner_id"), primary_key=True),
    Column("persona", String(32), primary_key=True),
    Column("copy_owner_id", ForeignKey("learning_identities.owner_id"), nullable=False, unique=True),
    Column("created_at", Float, nullable=False))
viewers = Table("learning_viewer_state", metadata,
    Column("viewer_owner_id", ForeignKey("learning_identities.owner_id"), primary_key=True),
    Column("active_persona", String(32)))
_ready: set[int] = set()
_build_lock = threading.Lock()
log = logging.getLogger("y.personas")


@lru_cache(maxsize=None)
def load(key: str) -> dict:
    if key not in KEYS:
        raise StoreError(404, "persona_not_found")
    value = json.loads((FIXTURES / f"{key}.json").read_text(encoding="utf-8"))
    recorded = FIXTURES / f"{key}.notes.json"
    value["recorded"] = json.loads(recorded.read_text(encoding="utf-8")) if recorded.exists() else None
    return value


def catalog() -> list[dict]:
    return [{k: load(key)[k] for k in ("key", "name", "blurb", "topics")} for key in KEYS]


def template_owner(key: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"y-persona-template:{key}"))


def _iso(stamp: float) -> str:
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat()


def belief_id(persona: dict, name: str) -> str:
    return f"{persona['beliefs'][name]['concept']}/belief-{name}"


def question_of(check: dict, qid: str) -> dict:
    return {"qid": qid, "kind": "mcq" if check.get("o") else "free", "q": check["q"], "options": check.get("o", []),
            "key": check["k"], "concept": check["c"], "dim": check["d"]}


def _refs(refs: list[str], found: list) -> list[str]:
    """Fixture refs -> this owner's observation ids: '#j' is the session's j-th check, 'concept/dim' every match."""
    by_check = {o.check_id.rsplit(".", 1)[-1]: str(o.observation_id) for o in found}
    out = []
    for ref in refs:
        if ref.startswith("#"):
            out += [by_check[ref[1:]]] if ref[1:] in by_check else []
        else:
            concept, _, dim = ref.rpartition("/")
            out += [str(o.observation_id) for o in found if o.concept == concept and o.dimension == dim]
    return list(dict.fromkeys(out))


def seeded_label(row: dict, check: dict, persona: dict) -> observations.Observation:
    """The fixture's label, shaped like a decision-model label: an outcome distribution where the seed decides,
    misconception mass on the persona's named beliefs, and a reasoning score."""
    verified = json.loads(row["verifier_json"])["verifier"]["result"]
    outcome = check.get("out") or verified or "correct"
    soft = {"outcome_p": OUTCOME_P[outcome] if check.get("out") else None}
    misconception = None
    if check.get("mis") and outcome != "correct":
        mid = belief_id(persona, check["mis"])
        soft["misconception_p"] = {mid: check["mp"]}
        soft["other_misconception_p"] = 0.05
        misconception = mid if check["mp"] >= 0.5 else None
    elif outcome != "correct":
        soft["other_misconception_p"] = 0.1
    if check.get("r") is not None:
        soft.update(reasoning=check["r"], reasoning_shown=0.9)
    return observations.build_observation(
        row, outcome, misconception=misconception, miss_class="discrimination" if misconception else None,
        labeler=SEED, label_confidence=max(OUTCOME_P[outcome].values()) if check.get("out") else 1.0, **soft)


class PersonaStore:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine
        self.evidence = observations.ObservationStore(capture)
        self.profiles = profile.ProfileStore(capture)
        self.turns = tutor_storage.TutorStore(capture)
        study.StudyStore(capture)
        image_jobs.ImageJobs(capture)
        if id(self.engine) not in _ready:
            metadata.create_all(self.engine, tables=[copies, viewers], checkfirst=True)
            _ready.add(id(self.engine))

    # -- building ----------------------------------------------------------------------------------

    def _identity(self, owner: str, expires_at: float) -> None:
        """An owner row with no cookie: its token hash is of a secret nobody holds, so it cannot sign in."""
        with self.engine.begin() as conn:
            if conn.scalar(select(identities.c.owner_id).where(identities.c.owner_id == owner)) is None:
                conn.execute(insert(identities).values(owner_id=owner, token_hash=digest(secrets.token_urlsafe(32)),
                                                      expires_at=expires_at))

    def populate(self, owner: str, key: str, staged: bool | None = None) -> None:
        """Build persona `key` into `owner`. On Postgres the build runs in a private in-memory SQLite and its rows
        are copied in one transaction: the direct build makes thousands of small commits (93 s on Neon, 0.3 s on
        SQLite). Ids are the same either way, so the copy is identical to a direct build."""
        if not (self.engine.dialect.name != "sqlite" if staged is None else staged):
            self.build(owner, key)
            return
        scratch_engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        try:
            scratch = CaptureStore(scratch_engine)
            scratch.initialize()
            PersonaStore(scratch).build(owner, key)
            skip = {identities.name, "learning_budgets", "learning_schema", copies.name, viewers.name}
            with scratch_engine.connect() as source, self.engine.begin() as target:
                for table in metadata.sorted_tables:
                    if table.name in skip:
                        continue
                    rows = [dict(row._mapping) for row in source.execute(select(table))]
                    if rows:
                        target.execute(insert(table), rows)
        finally:
            scratch_engine.dispose()

    def build(self, owner: str, key: str, now: float | None = None, notes_source=None) -> dict:
        """Build persona `key` into `owner` (idempotent). `notes_source(index, found, payload)` overrides the
        recorded notes (the recording script); by default notes and links come from the fixture files."""
        persona, now = load(key), now or time.time()
        self._identity(owner, now + 30 * 86400)
        recorded = (persona["recorded"] or {}).get("sessions", [])
        model = (persona["recorded"] or {}).get("model")
        built = 0
        for index, session in enumerate(persona["sessions"]):
            sid = str(uuid5(UUID(owner), f"{key}:{index}"))
            started = now - session["days_ago"] * 86400
            self.capture.create_session(owner, UUID(sid))
            with self.engine.begin() as conn:
                conn.execute(update(sessions).where(sessions.c.session_id == sid).values(created_at=started))
            turn_id = str(uuid5(UUID(sid), "question"))
            checks = [question_of(c, f"seed.{index}.{j}") for j, c in enumerate(session["checks"])]
            if self.turns.begin(owner, sid, turn_id, "question", {"text": session["title"]}, digest(session["title"])) is None:
                moves = [{"type": "seg", "id": "seed", "goal": session["title"]},
                         *({"type": "check", **{k: q[k] for k in ("kind", "q", "key", "concept", "dim", "options")}}
                           for q in checks), {"type": "turn_end"}]
                self.turns.finish(turn_id, "done", moves, None, None, {"seed": True, "tutor": {"model": "seed-fixture"}})
                with self.engine.begin() as conn:
                    conn.execute(update(tutor_storage.turns).where(tutor_storage.turns.c.turn_id == turn_id)
                                 .values(created_at=started))
            for j, (check, question) in enumerate(zip(session["checks"], checks)):
                fake = SimpleNamespace(choice=check["a"] if check.get("o") else None, text=check["a"],
                                       reveal=bool(check.get("reveal")), confidence=check.get("conf"))
                from .tutor_turn import grade  # the turn engine's own grading; imported late (it loads prompts)
                graded = grade(question, fake)
                view, created = self.evidence.capture_answer(
                    owner, sid, turn_id, question, graded["answer"], graded, "tap" if check.get("o") else "typed", [],
                    hint_ids=(f"{question['qid']}:1",) if check.get("hint") else (), at=started + (j + 1) * CHECK_SPACING)
                if view["status"] == "pending":
                    row = self.evidence.claim(owner, view["observation_id"], charge=False)
                    if row is not None:
                        self.evidence.finish(view["observation_id"], "labeled", seeded_label(row, check, persona),
                                             {"provider": SEED, "model": None}, None, 0.0)
            closed = self._close(owner, key, persona, index, sid, started + (len(checks) + 1) * CHECK_SPACING,
                                 recorded[index] if index < len(recorded) else {}, model, notes_source)
            built += closed
        return {"owner": owner, "persona": key, "sessions": len(persona["sessions"]), "sealed_now": built}

    def _close(self, owner, key, persona, index, sid, at, recorded, model, notes_source) -> int:
        if self.profiles.begin_close(owner, sid) == "closed":
            return 0
        try:
            found, left = self.evidence.sealed(owner, sid)
            previous, _ = self.profiles.latest(owner)
            known = {b.concept for b in previous.beliefs} if previous else set()
            if notes_source is not None:
                raw = notes_source(index, found, sid, known)
            else:
                raw = {"notes": [{"text": n["text"], "cites": _refs(n["cites"], found)} for n in recorded.get("notes", [])],
                       "links": [{**k, "cites": _refs(k["cites"], found)} for k in recorded.get("links", [])]}
            authored = [{**k, "cites": _refs(k["cites"], found)} for k in persona.get("links", []) if k["session"] == index]
            raw = {**raw, "links": [*raw.get("links", []), *authored]}
            notes, dropped = keep_cited(raw, {str(o.observation_id) for o in found})
            links, links_dropped = keep_links(raw, found, known)
            links = [{**k, "provenance": SEED} for k in links]
            descriptions = {belief_id(persona, name): f"On {b['concept']}: {b['text']}" for name, b in persona["beliefs"].items()}
            consolidator = f"seed:{model} (recorded)" if model and notes else "seed-fixture"

            def build(prev, idx):
                revision, new_index = profile.reduce(prev, idx, found, sid, notes, consolidator, at=_iso(at),
                                                     descriptions=descriptions, links=links)
                close = {"session_id": sid, "revision": revision.revision, "sealed": len(found), "left_out": left,
                         "seed": True, "persona": key, "notes": [n.text for n in revision.notes],
                         "notes_trace": {"seed": True, "model": model, "kept": len(notes), "dropped": dropped,
                                         "links": len(links), "links_dropped": links_dropped},
                         "misconceptions": [m.id for m in revision.misconceptions if m.status == "active"],
                         "suspected": [m.id for m in revision.misconceptions if m.status == "suspected"], "ms": 0}
                return revision, new_index, close

            self.profiles.write(owner, sid, build)
            return 1
        except BaseException:
            self.profiles.abort_close(sid)
            raise

    # -- viewers and copies ------------------------------------------------------------------------

    def active(self, viewer: str) -> str | None:
        with self.engine.connect() as conn:
            return conn.scalar(select(viewers.c.active_persona).where(viewers.c.viewer_owner_id == viewer))

    def copy_owner(self, viewer: str, key: str) -> str | None:
        with self.engine.connect() as conn:
            return conn.scalar(select(copies.c.copy_owner_id).where(copies.c.viewer_owner_id == viewer,
                                                                    copies.c.persona == key))

    def effective(self, viewer: str) -> str:
        """The owner a viewer's requests act as: its active persona copy, else itself."""
        with self.engine.connect() as conn:
            copy = conn.scalar(select(copies.c.copy_owner_id).join(viewers, (viewers.c.viewer_owner_id == copies.c.viewer_owner_id)
                                                                   & (viewers.c.active_persona == copies.c.persona))
                               .where(copies.c.viewer_owner_id == viewer))
        return copy or viewer

    def _spend(self, viewer: str) -> None:
        hour = int(time.time() // 3600)
        with self.engine.begin() as conn:
            self.capture._spend(conn, f"persona-global:{hour}", HOURLY_BUILDS_GLOBAL)
            self.capture._spend(conn, f"persona-{viewer}:{hour}", HOURLY_BUILDS)

    def ensure_copy(self, viewer: str, key: str) -> str:
        """The viewer's private copy of persona `key`, built on first use."""
        load(key)
        owner = self.copy_owner(viewer, key)
        if owner is not None:
            return owner
        started = time.perf_counter()
        self._spend(viewer)
        spent = time.perf_counter()
        with _build_lock:
            locked = time.perf_counter()
            owner = self.copy_owner(viewer, key)
            if owner is None:
                owner = str(uuid5(UUID(viewer), f"persona:{key}:{secrets.token_hex(8)}"))
                with self.engine.connect() as conn:
                    expires = conn.scalar(select(identities.c.expires_at).where(identities.c.owner_id == viewer))
                self._identity(owner, expires or time.time() + 30 * 86400)
                self.populate(owner, key)
                try:
                    with self.engine.begin() as conn:
                        conn.execute(insert(copies).values(viewer_owner_id=viewer, persona=key, copy_owner_id=owner,
                                                           created_at=time.time()))
                except IntegrityError:  # another instance finished first; keep its copy, drop ours
                    self.wipe(owner, keep_identity=False)
                    owner = self.copy_owner(viewer, key)
        log.warning("persona copy %s: budget %.2f s, lock wait %.2f s, build %.2f s", key, spent - started,
                    locked - spent, time.perf_counter() - locked)
        return owner

    def activate(self, viewer: str, key: str | None) -> dict:
        if key is not None:
            self.ensure_copy(viewer, key)
        if self.engine.dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as upsert
        else:
            from sqlalchemy.dialects.sqlite import insert as upsert
        with self.engine.begin() as conn:
            statement = upsert(viewers).values(viewer_owner_id=viewer, active_persona=key)
            conn.execute(statement.on_conflict_do_update(index_elements=[viewers.c.viewer_owner_id],
                                                         set_={"active_persona": key}))
        return self.listing(viewer)

    def reset(self, viewer: str, key: str) -> dict:
        """Throw away the viewer's copy (and anything learned in it) and rebuild it from the fixture."""
        load(key)
        owner = self.copy_owner(viewer, key)
        if owner is None:
            raise StoreError(404, "persona_copy_not_found")
        self._spend(viewer)
        with _build_lock:
            self.wipe(owner)
            self.populate(owner, key)
        return self.listing(viewer)

    def name_of(self, owner: str) -> str | None:
        """The persona name an owner is a copy of, or None for a viewer's own profile."""
        with self.engine.connect() as conn:
            key = conn.scalar(select(copies.c.persona).where(copies.c.copy_owner_id == owner))
        return load(key)["name"] if key else None

    def owns(self, viewer: str, owner: str) -> bool:
        return owner == viewer or owner in self._copies(viewer).values()

    def _copies(self, viewer: str) -> dict[str, str]:
        with self.engine.connect() as conn:
            return dict(conn.execute(select(copies.c.persona, copies.c.copy_owner_id)
                                     .where(copies.c.viewer_owner_id == viewer)).all())

    def listing(self, viewer: str) -> dict:
        made = self._copies(viewer)
        return {"active": self.active(viewer), "personas": [{**p, "copied": p["key"] in made} for p in catalog()]}

    def transfer(self, sid: str, source: str, target: str) -> None:
        """Move an open, unsealed session to another of the same viewer's minds before it is closed."""
        with self.engine.begin() as conn:
            row = self.capture._session(conn, source, sid)
            if row["status"] != "open":
                raise StoreError(409, "session_not_open")
            conn.execute(update(sessions).where(sessions.c.session_id == sid).values(owner_id=target))
            conn.execute(update(observations.observations).where(observations.observations.c.session_id == sid)
                         .values(owner_id=target))
            conn.execute(update(attempts).where(attempts.c.session_id == sid).values(owner_id=target))

    def wipe(self, owner: str, keep_identity: bool = True) -> None:
        """Delete every row an owner has, children first (bounded: one persona copy)."""
        b = board_storage
        with self.engine.begin() as conn:
            ids = [r[0] for r in conn.execute(select(sessions.c.session_id).where(sessions.c.owner_id == owner))]
            if ids:
                runs = select(b.board_attempts.c.attempt_id).where(b.board_attempts.c.session_id.in_(ids))
                captured = select(attempts.c.attempt_id).where(attempts.c.session_id.in_(ids))
                conn.execute(delete(b.assessment_runs).where(b.assessment_runs.c.attempt_id.in_(runs)))
                conn.execute(delete(b.corrections).where(b.corrections.c.attempt_id.in_(runs)))
                conn.execute(delete(evaluations).where(evaluations.c.attempt_id.in_(captured)))
                for table in (b.board_attempts, b.assets, b.checkpoints, b.batches, b.boards, attempts, study.hints,
                              tutor_storage.turns, image_jobs.jobs, profile.session_memory, observations.observations):
                    conn.execute(delete(table).where(table.c.session_id.in_(ids)))
            conn.execute(delete(profile.revisions).where(profile.revisions.c.owner_id == owner))
            conn.execute(delete(sessions).where(sessions.c.owner_id == owner))
            if not keep_identity:
                conn.execute(delete(identities).where(identities.c.owner_id == owner))


def sweep_expired(store: PersonaStore, now: float | None = None, cap: int = 200) -> int:
    """Delete the persona copies of viewers whose identity has expired (daily cron); returns how many went."""
    now = now or time.time()
    with store.engine.connect() as conn:
        rows = conn.execute(select(copies.c.viewer_owner_id, copies.c.copy_owner_id)
                            .join(identities, identities.c.owner_id == copies.c.viewer_owner_id)
                            .where(identities.c.expires_at < now).limit(cap)).all()
    for viewer, copy in rows:
        with store.engine.begin() as conn:
            conn.execute(delete(copies).where(copies.c.copy_owner_id == copy))
            conn.execute(delete(viewers).where(viewers.c.viewer_owner_id == viewer))
        store.wipe(copy, keep_identity=False)
    return len(rows)


def summary(store: PersonaStore, owner: str) -> dict:
    """What a built persona shows: revisions, beliefs, ledger, links and due reviews (seed script, tests)."""
    revision, _ = store.profiles.latest(owner)
    if revision is None:
        return {"revisions": 0}
    checks = study.StudyStore(store.capture).latest_checks(owner, "")
    status = [m.status for m in revision.misconceptions]
    return {"revisions": revision.revision, "beliefs": len(revision.beliefs),
            "concepts": len({b.concept for b in revision.beliefs}),
            "misconceptions": {s: status.count(s) for s in ("active", "suspected", "resolved")},
            "links": {k: sum(1 for x in revision.links if x.kind == k) for k in ("builds_on", "confused_with")},
            "notes": len(revision.notes), "consolidator": revision.consolidator,
            "due": [(i["concept"], i["reason"]) for i in study.review_items(revision, checks, set())],
            "fingerprint": digest(canonical([b.model_dump(mode="json") for b in revision.beliefs]))[:12]}
