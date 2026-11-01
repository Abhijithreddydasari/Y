import asyncio
import json

import httpx
from fastapi import FastAPI

from learning.board_reader import MetaBoardReader
from learning.board_router import get_reader, router as board_router
from learning.decisions import BASETEN_MODELS, BasetenDecisionClient
from learning.router import get_provider, get_store, router
from learning.storage import CaptureStore, make_engine
from scripts.board_smoke import smoke


def test_default_smoke_cannot_make_network_calls(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No live flag: no network")
    monkeypatch.setattr(httpx, "AsyncClient", forbidden)
    report = asyncio.run(smoke())
    assert report["network_calls"] == 0
    assert not report["live_requested"]


def test_live_smoke_exercises_real_routes_with_mocked_paid_providers(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "mock-meta")
    store = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'smoke.db').as_posix()}"))
    store.initialize()
    app = FastAPI(); app.include_router(router); app.include_router(board_router)
    app.dependency_overrides[get_store] = lambda: store
    counts = {"meta": 0, "decision": 0}
    def decision(request):
        counts["decision"] += 1
        return httpx.Response(200, json={"model": BASETEN_MODELS["elephant"], "usage": {"input_tokens": 100, "output_tokens": 1},
            "answers": {"analytical": {"type": "choice", "choice": "supported", "confidence": .99,
                "probabilities": {"supported": .99, "contradicted": .005, "ambiguous": .003, "not_observable": .002}}}})
    def meta(request):
        counts["meta"] += 1
        text = json.dumps({"schema_version": 1, "items": [{"element_ids": ["ink-0", "ink-1"], "text": "4",
            "status": "readable", "critical": False, "relationships": []}]})
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]})
    app.dependency_overrides[get_provider] = lambda: BasetenDecisionClient("mock-baseten", transport=httpx.MockTransport(decision))
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(meta)) as provider_client:
            async def reader():
                yield MetaBoardReader(provider_client)
            app.dependency_overrides[get_reader] = reader
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://smoke.test") as client:
                return await smoke(True, client=client)
    try:
        report = asyncio.run(run())
        assert report["contract_checks_passed"]
        assert counts == {"meta": 1, "decision": 1}
        assert all(case["matches_reference"] and case["saved_before_assessment"] and case["profile_updated"] is False for case in report["cases"])
        assert report["cases"][1]["observations"][0]["status"] == "pending_review"
        assert "mock-meta" not in json.dumps(report) and "mock-baseten" not in json.dumps(report)
    finally:
        store.engine.dispose()
