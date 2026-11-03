"""Demo personas: seeded through the real pipeline, private copies per viewer, reset, close into a mind (mocked)."""
import json
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from learning import observations, personas
from learning.decisions import EvidenceLabeler
from learning.consolidate import NotesWriter
from learning.persona_router import router as persona_router
from learning.profile import ProfileStore
from learning.router import COOKIE, get_store, router
from learning.storage import CaptureStore, make_engine
from learning.tutor_router import get_labeler, get_notes_writer, router as tutor_router

NOW = 1_793_700_000.0  # a fixed clock, 2026-11-03


@pytest.fixture
def capture(tmp_path):
    store = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'personas.db').as_posix()}"))
    store.initialize()
    yield store
    store.engine.dispose()


@pytest.fixture
def app(capture):
    app = FastAPI()
    for r in (router, tutor_router, persona_router):
        app.include_router(r)
    app.dependency_overrides[get_store] = lambda: capture
    # No test reaches a labeler or the notes model.
    app.dependency_overrides[get_labeler] = lambda: EvidenceLabeler("")
    app.dependency_overrides[get_notes_writer] = lambda: NotesWriter(api_key="")
    return app


def viewer(app, capture):
    client = TestClient(app)
    token = capture.issue_identity()
    client.cookies.set(COOKIE, token)
    return client, capture.owner_for_token(token)


def revisions(capture, owner):
    return len(ProfileStore(capture).history(owner, 50))


def answered_session(client, capture, owner, correct=True):
    """An open live session under `owner` (the effective owner) with one deterministic mcq answer."""
    sid = str(uuid4())
    assert client.post("/learning/sessions", json={"session_id": sid}).status_code == 200
    question = {"qid": "t1.1", "kind": "mcq", "q": "Softmax of [2, 0]: first weight?", "options": ["0.88", "0.5"],
                "key": "0.88", "concept": "attention.softmax", "dim": "apply"}
    answer = "0.88" if correct else "0.5"
    graded = {"result": "correct" if correct else "incorrect", "verified": "correct" if correct else "incorrect",
              "method": "option", "answer": answer, "confidence": 65, "key_status": "ok"}
    observations.ObservationStore(capture).capture_answer(owner, sid, str(uuid4()), question, answer, graded, "tap", [])
    return sid


def test_seed_is_idempotent_and_deterministic(capture):
    store = personas.PersonaStore(capture)
    owner = personas.template_owner("priya")
    first = store.build(owner, "priya", now=NOW)
    latest = ProfileStore(capture).latest(owner)[0].model_dump_json()
    with capture.engine.connect() as conn:
        rows = conn.scalar(select(func.count()).select_from(observations.observations))
    again = store.build(owner, "priya", now=NOW)
    with capture.engine.connect() as conn:
        assert conn.scalar(select(func.count()).select_from(observations.observations)) == rows
    assert first["sealed_now"] == 7 and again["sealed_now"] == 0
    assert ProfileStore(capture).latest(owner)[0].model_dump_json() == latest
    other = str(uuid4())
    store.build(other, "priya", now=NOW)  # same fixture, another owner: the same beliefs
    assert personas.summary(store, other)["fingerprint"] == personas.summary(store, owner)["fingerprint"]


@pytest.mark.parametrize("key", personas.KEYS)
def test_seed_goes_through_the_pipeline_and_stays_labelled_seed(capture, key):
    store = personas.PersonaStore(capture)
    owner = personas.template_owner(key)
    store.build(owner, key, now=NOW)
    shown = personas.summary(store, owner)
    assert shown["revisions"] == 7 and shown["concepts"] >= 15
    assert shown["misconceptions"]["active"] >= 1 and shown["misconceptions"]["suspected"] >= 1
    assert shown["links"]["builds_on"] >= 3 and shown["links"]["confused_with"] >= 1
    assert shown["due"] and shown["consolidator"].startswith("seed")
    revision = ProfileStore(capture).latest(owner)[0]
    assert {d for b in revision.beliefs for d in [b.dimension]} == {"recall", "understand", "apply", "analyze", "transfer"}
    assert {k.provenance for k in revision.links} == {"seed"}
    with capture.engine.connect() as conn:
        found = [json.loads(r[0]) for r in conn.execute(select(observations.observations.c.observation_json)
                                                        .where(observations.observations.c.owner_id == owner))]
        keys = {r[0] for r in conn.execute(select(observations.observations.c.key_status)
                                           .where(observations.observations.c.owner_id == owner))}
    assert len(found) >= 35 and {o["labeler"] for o in found} <= {"seed", "deterministic"}
    assert keys == {"ok"}  # no seeded question trips the key audit


def test_copies_are_private_and_the_template_is_never_touched(app, capture):
    store = personas.PersonaStore(capture)
    store.build(personas.template_owner("priya"), "priya")
    a, viewer_a = viewer(app, capture)
    b, viewer_b = viewer(app, capture)
    assert a.put("/learning/personas/active", json={"persona": "priya"}).json()["active"] == "priya"
    b.put("/learning/personas/active", json={"persona": "priya"})
    copy_a, copy_b = store.effective(viewer_a), store.effective(viewer_b)
    assert len({copy_a, copy_b, viewer_a, viewer_b, personas.template_owner("priya")}) == 5
    assert a.get("/learning/profile").json()["revision"]["revision"] == 7
    sid = answered_session(a, capture, copy_a)
    closed = a.post(f"/learning/sessions/{sid}/close").json()
    assert closed["profile_updated"] and closed["revision"] == 8 and closed["persona"] == "Priya Nair"
    assert revisions(capture, copy_a) == 8 and revisions(capture, copy_b) == 7
    assert revisions(capture, personas.template_owner("priya")) == 7
    # A's live session belongs to A's copy only.
    assert b.get(f"/learning/sessions/{sid}").status_code == 404
    assert a.get("/learning/canvases").json()["canvases"][0]["session_id"] == sid


def test_switching_back_to_your_own_restores_your_profile_and_hides_the_copy(app, capture):
    a, viewer_a = viewer(app, capture)
    sid = answered_session(a, capture, viewer_a)
    a.post(f"/learning/sessions/{sid}/close")
    own = a.get("/learning/profile").json()["revision"]
    a.put("/learning/personas/active", json={"persona": "tomas"})
    persona_sid = str(uuid4())
    a.post("/learning/sessions", json={"session_id": persona_sid})
    assert a.get("/learning/profile").json()["revision"]["revision"] == 7
    assert a.get(f"/learning/sessions/{sid}").status_code == 404  # your own session is not the persona's
    listed = a.put("/learning/personas/active", json={"persona": None}).json()
    assert listed["active"] is None and [p["copied"] for p in listed["personas"]] == [False, True, False]
    assert a.get("/learning/profile").json()["revision"] == own
    assert a.get(f"/learning/sessions/{persona_sid}").status_code == 404
    assert a.post("/learning/identity").json()["persona"] is None


def test_reset_restores_the_template_copy(app, capture):
    a, viewer_a = viewer(app, capture)
    a.put("/learning/personas/active", json={"persona": "amara"})
    copy = personas.PersonaStore(capture).effective(viewer_a)
    before = a.get("/learning/profile").json()["revision"]
    sid = answered_session(a, capture, copy, correct=False)
    a.post(f"/learning/sessions/{sid}/close")
    assert revisions(capture, copy) == 8
    assert a.post("/learning/personas/amara/reset").status_code == 200
    assert revisions(capture, copy) == 7
    after = a.get("/learning/profile").json()["revision"]
    assert [b["concept"] for b in after["beliefs"]] == [b["concept"] for b in before["beliefs"]]
    assert a.get(f"/learning/sessions/{sid}").status_code == 404
    assert a.post("/learning/personas/priya/reset").status_code == 404  # no copy of priya yet


def test_close_into_another_of_your_minds(app, capture):
    a, viewer_a = viewer(app, capture)
    sid = answered_session(a, capture, viewer_a)  # on your own board
    closed = a.post(f"/learning/sessions/{sid}/close", json={"into": "priya"}).json()
    copy = personas.PersonaStore(capture).copy_owner(viewer_a, "priya")
    assert closed["revision"] == 8 and revisions(capture, copy) == 8 and revisions(capture, viewer_a) == 0
    assert a.get("/learning/profile").json()["revision"] is None  # still acting as yourself
    assert a.post(f"/learning/sessions/{sid}/close", json={"into": "priya"}).status_code == 404  # it moved
    # And back: a persona board saved into your own mind.
    a.put("/learning/personas/active", json={"persona": "priya"})
    two = answered_session(a, capture, copy)
    back = a.post(f"/learning/sessions/{two}/close", json={"into": "own"}).json()
    assert back["revision"] == 1 and back["persona"] is None
    assert revisions(capture, viewer_a) == 1 and revisions(capture, copy) == 8


def test_persona_routes_need_a_cookie_and_a_known_persona(app, capture):
    anonymous = TestClient(app)
    assert anonymous.get("/learning/personas").status_code == 401
    assert anonymous.put("/learning/personas/active", json={"persona": "priya"}).status_code == 401
    a, _ = viewer(app, capture)
    assert a.put("/learning/personas/active", json={"persona": "nobody"}).status_code == 404
    assert a.put("/learning/personas/active", json={"persona": "../x"}).status_code == 422
    assert a.post("/learning/sessions/" + str(uuid4()) + "/close", json={"into": "nobody"}).status_code == 404


def test_seeded_trace_names_no_live_model(app, capture):
    a, viewer_a = viewer(app, capture)
    a.put("/learning/personas/active", json={"persona": "priya"})
    sid = a.get("/learning/canvases").json()["canvases"][0]["session_id"]
    shown = a.get(f"/learning/sessions/{sid}/trace").json()
    assert shown["turns"][0]["seed"] and not shown["turns"][0]["model_call"]
    assert {row["labeler"] for row in shown["labels"]} <= {"seed", "deterministic"}
    assert shown["close"]["seed"] and shown["close"]["notes_model"] == "seed"


def test_staged_build_copies_the_same_persona_in_one_transaction(tmp_path):
    """Hosted Postgres builds in a scratch SQLite and copies the rows; the result must match a direct build."""
    results = {}
    for staged in (False, True):
        store = CaptureStore(make_engine(f"sqlite:///{(tmp_path / f'staged-{staged}.db').as_posix()}"))
        store.initialize()
        people = personas.PersonaStore(store)
        owner = store.owner_for_token(store.issue_identity())
        people.populate(owner, "tomas", staged=staged)
        # The fingerprint covers decayed beliefs, which depend on the build instant; everything else must match.
        results[staged] = {k: v for k, v in personas.summary(people, owner).items() if k != "fingerprint"}
        with store.engine.connect() as conn:
            results[(staged, "sessions")] = conn.scalar(select(func.count()).select_from(personas.sessions)
                                                        .where(personas.sessions.c.owner_id == owner))
        store.engine.dispose()
    assert results[True] == results[False] and results[True]["revisions"] == 7
    assert results[(True, "sessions")] == results[(False, "sessions")] == 7
