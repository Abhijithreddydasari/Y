import asyncio
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from learning.board_contracts import ContextInput, ContextPacket, Crop, Edit, EditBatch, Element, Rect, RegionInput
from learning.board_context import MAX_CONTEXT, bounds, build_context, model_context
from learning.board_reader import MetaBoardReader, interpret
from learning.board_router import get_reader, router as board_router
from learning.board_storage import BoardStore, assets, batches, checkpoints, upgrade
from learning.contracts import canonical
from learning.decisions import BasetenDecisionClient
from learning.router import get_provider, get_store, router
from learning.storage import CaptureStore, StoreError, make_engine


@pytest.fixture
def setup(tmp_path):
    capture = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'board.db').as_posix()}"))
    capture.initialize()
    owner = capture.owner_for_token(capture.issue_identity())
    sid = uuid4()
    capture.create_session(owner, sid)
    yield capture, BoardStore(capture), owner, sid
    capture.engine.dispose()


def element(id="answer", text="4", **kwargs):
    return Element(id=id, type="text", x=100, y=300, width=120, height=30, text=text, **kwargs)


def save(store, owner, sid, e=None, actor="human", revision=None, operation=None, **kwargs):
    current = store.load(owner, sid)["revision"] if revision is None else revision
    return store.apply(owner, sid, EditBatch(operation_id=operation or uuid4(), expected_revision=current,
        edits=[Edit(element=e or element(), actor=actor, **kwargs)]))


def png(w=100, h=100):
    out = BytesIO()
    Image.new("RGB", (w, h), "white").save(out, format="PNG")
    return out.getvalue()


def task_attempt(store, owner, sid, text="4", visual=False):
    region = store.region(owner, sid, RegionInput(region_id=uuid4(), task_id="cv.stereo.depth.v1", expected_revision=0))
    e = element(text=text) if not visual else Element(id="ink", type="freedraw", x=100, y=300, width=100, height=30, points=[[0, 0], [100, 30]])
    save(store, owner, sid, e)
    crops = []
    if visual:
        key = store.put_asset(owner, sid, png())["hash"]
        crops = [Crop(asset_hash=key, bounds=Rect(x=100, y=300, w=100, h=30), element_ids=["ink"], purpose=p) for p in ("initial", "detail")]
    request = ContextInput(request_id=uuid4(), revision=2, region_id=region["region_id"], crops=crops)
    value = store.capture_context(owner, sid, request)
    return request, ContextPacket.model_validate(value)


def test_additive_upgrade_and_exact_history(setup):
    capture, store, owner, sid = setup
    from learning.contracts import AttemptInput
    from learning.packs import TASKS
    typed = AttemptInput(attempt_id=uuid4(), task_id="cv.stereo.depth.v1", text="4")
    original = capture.capture(owner, sid, typed, TASKS[typed.task_id])
    upgrade(capture.engine)
    assert capture.get_attempt(owner, typed.attempt_id) == original
    first = element(text=" 4\n🧠 ")
    op = uuid4()
    assert save(store, owner, sid, first, operation=op, revision=0) == save(store, owner, sid, first, operation=op, revision=0)
    deleted = first.model_copy(update={"isDeleted": True, "version": 2})
    save(store, owner, sid, deleted)
    save(store, owner, sid, first)  # Undo may restore an older Excalidraw version.
    assert store.load(owner, sid, 1)["records"]["answer"]["element"]["text"] == " 4\n🧠 "
    assert store.load(owner, sid, 2)["records"]["answer"]["element"]["isDeleted"]
    assert not store.load(owner, sid)["records"]["answer"]["element"]["isDeleted"]
    with pytest.raises(StoreError) as error:
        save(store, owner, sid, element(text="different"), operation=op, revision=0)
    assert error.value.code == "board_operation_reused"


def test_conflicting_writes_and_concurrent_duplicate_operation(setup):
    _, store, owner, sid = setup
    operation = uuid4()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: save(store, owner, sid, operation=operation, revision=0), range(2)))
    assert results[0] == results[1]
    assert store.load(owner, sid)["revision"] == 1
    with pytest.raises(StoreError) as error:
        save(store, owner, sid, element(id="other"), revision=0)
    assert error.value.code == "board_revision_conflict"


def test_checkpoint_and_historical_reconstruction(setup):
    capture, store, owner, sid = setup
    for i in range(52):
        save(store, owner, sid, element(text=str(i)))
    assert store.load(owner, sid, 49)["records"]["answer"]["element"]["text"] == "48"
    assert store.load(owner, sid, 51)["records"]["answer"]["element"]["text"] == "50"
    with capture.engine.connect() as conn:
        assert conn.scalar(select(func.count()).select_from(checkpoints)) == 1
        assert conn.scalar(select(func.count()).select_from(batches)) == 52


def test_authorship_is_not_reset_by_edit_or_undo(setup):
    _, store, owner, sid = setup
    save(store, owner, sid, actor="model", source_revision=0)
    save(store, owner, sid, element(text="my version"))
    record = store.load(owner, sid)["records"]["answer"]
    assert (record["creator"], record["editor"], record["mixed"]) == ("model", "human", True)
    save(store, owner, sid, actor="model", source_revision=1)
    assert store.load(owner, sid)["records"]["answer"]["mixed"]


def test_assets_dedupe_ownership_missing_bytes_and_image_validation(setup):
    capture, store, owner, sid = setup
    blob = png()
    asset = store.put_asset(owner, sid, blob)
    assert store.put_asset(owner, sid, blob) == asset
    assert asset["hash"] == hashlib.sha256(blob).hexdigest()
    assert store.get_asset(owner, sid, asset["hash"])["content"] == blob
    other = capture.owner_for_token(capture.issue_identity())
    with pytest.raises(StoreError): store.get_asset(other, sid, asset["hash"])
    with pytest.raises(StoreError): store.put_asset(owner, sid, b"not image")
    with pytest.raises(StoreError): store.put_asset(owner, sid, b"x" * (2 * 1024 * 1024 + 1))
    e = Element(id="image", type="image", x=0, y=0, width=10, height=10, fileId="local")
    with pytest.raises(StoreError): save(store, owner, sid, e)
    assert store.load(owner, sid)["revision"] == 0
    save(store, owner, sid, e.model_copy(update={"customData": {"yAssetHash": asset["hash"]}}))


def test_native_task_capture_and_source_receipt_remain_frozen(setup):
    _, store, owner, sid = setup
    request, packet = task_attempt(store, owner, sid)
    assert packet.coverage["complete"]
    assert packet.task_id == "cv.stereo.depth.v1"
    assert packet.source.element_revisions["answer"] == 2
    save(store, owner, sid, element(text="wrong later"))
    assert store.capture_context(owner, sid, request) == packet.model_dump(mode="json")
    assert next(f for f in store.attempt(owner, request.request_id)["packet"]["focused"] if f["id"] == "answer")["text"] == "4"


def record(e, creator="human", region=None):
    return {"element": e, "revision": 1, "creator": creator, "editor": creator, "mixed": False, "task_region": region}


def test_context_relation_closure_rotations_and_outside_work():
    sid, rid = uuid4(), str(uuid4())
    scene = {"a": record(element(id="a").model_dump()),
             "b": record({**element(id="b").model_dump(), "x": 5000}),
             "arrow": record({**element(id="arrow").model_dump(), "type": "arrow", "startBinding": {"elementId": "a"}, "endBinding": {"elementId": "b"}}),
             "outside": record({**element(id="outside").model_dump(), "x": -5000}, region=rid)}
    request = ContextInput(request_id=uuid4(), revision=1, region_id=rid)
    packet = build_context(sid, 1, scene, [{"region_id": rid, "task_id": "cv.stereo.depth.v1", "bounds": {"x": 0, "y": 0, "w": 500, "h": 600}}], request)
    assert {"a", "b", "arrow"} <= {f["id"] for f in packet.focused}
    assert packet.coverage["outside_task"] == ["outside"]
    b = bounds({**element().model_dump(), "angle": 3.141592653589793 / 2})
    assert b["h"] == pytest.approx(120)
    assert b["w"] == pytest.approx(30)


@pytest.mark.parametrize("count", [500, 5000])
def test_large_board_context_is_bounded_and_benchmark(count):
    scene = {f"e{i}": record({**element(id=f"e{i}", text="label " * 15).model_dump(), "x": (i % 100) * 200, "y": (i // 100) * 50}) for i in range(count)}
    start = time.perf_counter()
    packet = build_context(uuid4(), 1, scene, [], ContextInput(request_id=uuid4(), revision=1, viewport=Rect(x=0, y=0, w=400, h=1000)))
    elapsed = (time.perf_counter() - start) * 1000
    size = len(canonical(model_context(packet)).encode())
    print(f"board_context elements={count} ms={elapsed:.2f} bytes={size}")
    assert size <= MAX_CONTEXT
    assert len(packet.focused) <= 200


def reader_response(status="readable", text="4", critical=False, ids=None):
    result = {"schema_version": 1, "items": [{"element_ids": ids or ["ink"], "text": text,
        "status": status, "critical": critical, "relationships": []}]}
    return {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}


def test_reader_focused_retry_cache_and_invalidation(setup, monkeypatch):
    _, store, owner, sid = setup
    _, packet = task_attempt(store, owner, sid, visual=True)
    monkeypatch.setenv("MODEL_API_KEY", "test")
    calls = []
    def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=reader_response("ambiguous", "4 or 9", True) if len(calls) == 1 else reader_response())
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            reader = MetaBoardReader(client)
            first = await interpret(store, owner, packet, reader)
            second = await interpret(store, owner, packet, reader)
            assert first["calls"] == 2 and not first["unresolved"]
            assert second["cache_hit"] and second["calls"] == 0
            packet.focused[1]["text"] = "different context"
            await interpret(store, owner, packet, reader)
    asyncio.run(run())
    assert len(calls) == 3
    assert "solve" in calls[0]["instructions"]


@pytest.mark.parametrize("response", [reader_response(ids=["foreign"]), {"status": "incomplete", "output": []}, {"output": []}])
def test_reader_rejects_foreign_or_incomplete_reading(setup, monkeypatch, response):
    from learning.decisions import ProviderFailure
    _, store, owner, sid = setup
    _, packet = task_attempt(store, owner, sid, visual=True)
    monkeypatch.setenv("MODEL_API_KEY", "test")
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response))) as client:
            with pytest.raises(ProviderFailure): await interpret(store, owner, packet, MetaBoardReader(client))
    asyncio.run(run())


def test_reading_claims_and_stale_workers(setup):
    _, store, _, _ = setup
    token, value = store.claim_reading("key")
    assert token and value is None
    with pytest.raises(StoreError): store.claim_reading("key")
    with pytest.raises(StoreError): store.finish_reading("key", "stale", {}, 60)
    store.finish_reading("key", token, {"text": "read"}, 60)
    assert store.claim_reading("key") == (None, {"text": "read"})


def test_board_api_native_assessment_and_missing_key_preserve_source(setup, monkeypatch):
    capture, store, _, _ = setup
    app = FastAPI(); app.include_router(router); app.include_router(board_router)
    app.dependency_overrides[get_store] = lambda: capture
    app.dependency_overrides[get_provider] = lambda: BasetenDecisionClient("")
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    with TestClient(app) as client:
        client.post("/learning/identity")
        sid = uuid4()
        client.post("/learning/sessions", json={"session_id": str(sid)})
        owner = capture.owner_for_token(client.cookies.get("y_learning_identity"))
        request, packet = task_attempt(store, owner, sid)
        result = client.post(f"/learning/board-attempts/{request.request_id}/assess").json()
        assert result["result"]["observations"][0]["status"] == "accepted"
        assert result["result"]["board_source"] == packet.source.model_dump(mode="json")
        assert result["profile_updated"] is False
        assert client.get(f"/learning/sessions/{sid}/board/attempts").status_code == 200


def test_model_and_mixed_text_are_not_independent_evidence(setup):
    from learning.board_router import evidence_text
    _, store, owner, sid = setup
    _, packet = task_attempt(store, owner, sid)
    for f in packet.focused:
        if f["id"] == "answer": f["mixed"] = True
    assert evidence_text(packet, {"items": []}) == ""


def test_authenticated_teaching_reuses_frozen_capture_and_streams_native_context(setup, monkeypatch):
    import teacher
    import learning.board_router as module
    capture, store, _, _ = setup
    calls = []
    async def stream(teacher, prompt, images, safety):
        calls.append((json.loads(prompt), images))
        yield '[text: "Use the saved equation."]'
        yield '[equation: latex="z=fB/d"]'
    monkeypatch.setattr(teacher, "stream_board_context", stream)
    monkeypatch.setattr(module, "get_board_teacher", lambda _: object())
    app = FastAPI(); app.include_router(router); app.include_router(board_router)
    app.dependency_overrides[get_store] = lambda: capture
    with TestClient(app) as client:
        client.post("/learning/identity")
        sid = uuid4(); client.post("/learning/sessions", json={"session_id": str(sid)})
        owner = capture.owner_for_token(client.cookies.get("y_learning_identity"))
        request, _ = task_attempt(store, owner, sid)
        response = client.post(f"/learning/sessions/{sid}/board/teach", json={**request.model_dump(mode="json"), "model_choice": "edge"})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert '"tag": "equation"' in response.text
        assert "event: done" in response.text and "event: error" not in response.text
        assert calls[0][1] == []  # No dummy PNG for native text.
        assert any(f["text"] == "4" for f in calls[0][0]["board"]["focused"])


@pytest.mark.parametrize("field,value", [("points", [[1, float("nan")]]), ("customData", {"bad": float("inf")}), ("startBinding", "not a binding")])
def test_malformed_scene_metadata_is_rejected(field, value):
    from pydantic import ValidationError
    with pytest.raises(ValidationError): element(**{field: value})
