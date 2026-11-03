"""H9 deployment guards: proxy-only API, production budgets, persona-copy sweep and the Modal image's module list."""
import ast
import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from learning import tutor_storage
from learning.app import app
from learning.personas import PersonaStore, copies, sweep_expired
from learning.router import get_store
from learning.storage import CaptureStore, StoreError, identities, limit, make_engine, sessions

API = Path(__file__).resolve().parents[1]


@pytest.fixture
def capture(tmp_path):
    store = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'deploy.db').as_posix()}"))
    store.initialize()
    yield store
    store.engine.dispose()


def test_api_answers_only_the_proxy_when_a_secret_is_set(capture, monkeypatch):
    app.dependency_overrides[get_store] = lambda: capture
    try:
        client = TestClient(app)
        monkeypatch.delenv("LEARNING_PROXY_SECRET", raising=False)
        assert client.post("/learning/identity").status_code == 200  # local dev: no secret, no check
        monkeypatch.setenv("LEARNING_PROXY_SECRET", "s3cret-value")
        denied = client.post("/learning/identity")
        assert (denied.status_code, denied.json()) == (403, {"detail": "proxy_required"})
        assert client.post("/learning/identity", headers={"X-Y-Proxy-Secret": "wrong"}).status_code == 403
        assert client.post("/learning/identity", headers={"X-Y-Proxy-Secret": "s3cret-value"}).status_code == 200
        assert client.get("/health").status_code == 200  # Modal and uptime checks stay open
    finally:
        app.dependency_overrides.clear()


def test_limits_take_deployment_overrides(monkeypatch):
    assert limit("NOT_SET_ANYWHERE", 7) == 7
    monkeypatch.setenv("Y_LIMIT_SOMETHING", "3")
    assert limit("SOMETHING", 7) == 3
    monkeypatch.setenv("Y_LIMIT_SOMETHING", "junk")
    assert limit("SOMETHING", 7) == 7


def test_charge_names_the_exhausted_budget(capture):
    owner = capture.owner_for_token(capture.issue_identity())
    capture.charge("speech", owner, 2, 10)
    capture.charge("speech", owner, 2, 10)
    with pytest.raises(StoreError) as caught:
        capture.charge("speech", owner, 2, 10)
    assert (caught.value.status, caught.value.code) == (429, "speech_budget_exhausted")
    other = capture.owner_for_token(capture.issue_identity())
    with pytest.raises(StoreError):
        capture.charge("speech", other, 5, 2)  # global bucket already holds 2


def test_daily_tutor_cap_applies_across_owners(capture, monkeypatch):
    monkeypatch.setattr(tutor_storage, "DAILY_TURNS_GLOBAL", 2)
    store = tutor_storage.TutorStore(capture)
    owners = [capture.owner_for_token(capture.issue_identity()) for _ in range(3)]
    store.reserve(owners[0])
    store.reserve(owners[1])
    with pytest.raises(StoreError):
        store.reserve(owners[2])


def test_sweep_removes_only_expired_viewers_copies(capture):
    personas = PersonaStore(capture)
    live, gone = (capture.owner_for_token(capture.issue_identity()) for _ in range(2))
    live_copy, gone_copy = personas.ensure_copy(live, "priya"), personas.ensure_copy(gone, "priya")
    with capture.engine.begin() as conn:
        conn.execute(identities.update().where(identities.c.owner_id == gone).values(expires_at=time.time() - 1))
    assert sweep_expired(personas) == 1
    with capture.engine.connect() as conn:
        assert [r[0] for r in conn.execute(copies.select().with_only_columns(copies.c.copy_owner_id))] == [live_copy]
        owners = {r[0] for r in conn.execute(sessions.select().with_only_columns(sessions.c.owner_id))}
        assert gone_copy not in owners and live_copy in owners
        assert conn.scalar(identities.select().with_only_columns(identities.c.owner_id)
                           .where(identities.c.owner_id == gone_copy)) is None
    assert sweep_expired(personas) == 0


def test_modal_image_ships_every_top_level_module_the_app_imports():
    tree = ast.parse((API.parent / "deploy" / "modal_learning.py").read_text(encoding="utf-8"))
    shipped = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                   and getattr(node.targets[0], "id", "") == "MODULES")
    local = {path.stem for path in API.glob("*.py")}
    needed, queue = set(), [p for p in (API / "learning").glob("*.py")]
    while queue:
        source = queue.pop().read_text(encoding="utf-8")
        for name in re.findall(r"^\s*(?:from|import) ([a-z_]+)", source, re.M):
            if name in local and name not in needed:
                needed.add(name)
                queue.append(API / f"{name}.py")
    assert needed <= {Path(m).stem for m in shipped}, needed - {Path(m).stem for m in shipped}
