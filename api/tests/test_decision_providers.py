import asyncio
import json
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from learning.assessment import assess_capture
from learning.contracts import AttemptInput, CapturedAttempt, SourceRef, canonical, digest, now_iso
from learning.decisions import BASETEN_MODELS, BasetenDecisionClient, configured_provider
from learning.jev import JevClient
from learning.packs import TASKS
from learning.router import get_provider, get_store, router
from learning.storage import CaptureStore, attempts, budgets, evaluations, make_engine


def capture():
    text = "By linearity A(-2v)=-2Av=3(-2v), so its eigenvalue remains 3."
    task = TASKS["linear.eigenvector.explain.v1"]
    return CapturedAttempt(owner_id="private-owner", session_id=uuid4(), task=task, captured_at=now_iso(),
        attempt=AttemptInput(attempt_id=uuid4(), task_id=task.task_id, text=text),
        source=SourceRef(event_id=uuid4(), content_hash=digest(text), start=0, end=len(text)))


def response(model):
    return {"model": model, "usage": {"input_tokens": 123, "output_tokens": 1}, "answers": {
        "analytical": {"type": "choice", "choice": "supported", "confidence": .96,
                       "probabilities": {"supported": .97, "contradicted": .01, "ambiguous": .01, "not_observable": .01}}
    }}


@pytest.mark.parametrize("model", BASETEN_MODELS.values())
def test_baseten_models_use_documented_endpoint_and_preserve_provider_identity(model):
    item = capture()
    seen = []

    def endpoint(request):
        seen.append(request)
        assert str(request.url) == "https://inference.baseten.co/v1/systemone"
        assert request.headers["authorization"] == "Bearer baseten-test-key"
        body = json.loads(request.content)
        assert body["model"] == model
        assert body["service_tier"] == "default"
        assert body["state"]["learner_answer"] == item.attempt.text
        assert "private-owner" not in request.content.decode()
        assert set(body["questions"]) == {"analytical"}
        return httpx.Response(200, json=response(model))

    provider = BasetenDecisionClient("baseten-test-key", model=model, transport=httpx.MockTransport(endpoint))
    result = asyncio.run(assess_capture(item, provider))
    observation = result.observations[0]
    assert len(seen) == 1
    assert observation.provider == "baseten"
    assert observation.model_version == model
    assert observation.model_is_alias is True
    assert observation.status == "pending_review"
    assert observation.reasons == ("decision_shadow_mode",)
    assert result.raw_result == response(model)
    assert result.usage["input_tokens"] == 123
    assert result.profile_updated is False


def test_provider_selection_is_explicit_and_never_reuses_other_providers_key(monkeypatch):
    monkeypatch.delenv("DECISION_PROVIDER", raising=False)
    monkeypatch.setenv("BASETEN_API_KEY", "set-but-not-selected")
    assert configured_provider().api_key == ""  # no setting: nothing non-Meta is called, whatever keys exist
    monkeypatch.setenv("DECISION_PROVIDER", "baseten")
    monkeypatch.delenv("BASETEN_DECISION_MODEL", raising=False)
    monkeypatch.delenv("BASETEN_API_KEY", raising=False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "typesafe-only")
    provider = configured_provider()
    assert provider.provider_name == "baseten"
    assert provider.api_key == ""
    assert asyncio.run(assess_capture(capture(), provider)).provider_error == "provider_not_configured"
    monkeypatch.setenv("BASETEN_API_KEY", "baseten-only")
    assert configured_provider().api_key == "baseten-only"
    monkeypatch.setenv("DECISION_PROVIDER", "jev")
    assert configured_provider().api_key == "typesafe-only"
    assert configured_provider().endpoint == "https://api.typesafe.ai/v1/systemone"
    monkeypatch.setenv("DECISION_PROVIDER", "unknown")
    with pytest.raises(ValueError):
        configured_provider()


@pytest.mark.parametrize("body", [
    b'{"model":"x","value":NaN}',
    b'{"model":"x","value":Infinity}',
    b'{"model":"x","value":1e999}',
    b'{"model":"first","model":"second"}',
    b'{"answers":{"a":{"choice":"supported","choice":"contradicted"}}}',
    b'[' * 1500 + b'0' + b']' * 1500,
    b'{"nested":' * 300 + b'0' + b'}' * 300,
    b'{"model":"\\ud800"}',
    b'{"model":"\\udfff"}',
    b'not json',
], ids=["nan", "infinity", "overflow", "duplicate-root", "duplicate-nested", "parser-depth",
        "storage-depth", "high-surrogate", "low-surrogate", "non-json"])
@pytest.mark.parametrize("client", [JevClient, BasetenDecisionClient])
def test_malformed_wire_json_abstains_and_remains_persistable(body, client):
    provider = client("test", transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)))
    result = asyncio.run(assess_capture(capture(), provider))
    assert result.provider_error == "provider_invalid_response"
    assert all(item.status == "abstained" for item in result.observations)
    # Regression: an overflowed JSON float used to survive in raw_result and break storage.
    assert canonical(result).encode("utf-8")


def test_oversized_baseten_response_is_rejected_before_parsing():
    provider = BasetenDecisionClient("test", transport=httpx.MockTransport(
        lambda _: httpx.Response(200, content=b" " * 131073)))
    result = asyncio.run(assess_capture(capture(), provider))
    assert result.provider_error == "provider_response_too_large"
    assert result.raw_result is None


def test_wrong_model_is_not_silently_accepted():
    provider = BasetenDecisionClient("test", transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json=response(BASETEN_MODELS["joey"]))))
    result = asyncio.run(assess_capture(capture(), provider))
    assert result.provider_error == "provider_model_mismatch"


def test_missing_key_does_not_spend_budget_or_exhaust_retry_and_configuration_unlocks_attempt(tmp_path):
    store = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'capture.db').as_posix()}"))
    store.initialize()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_provider] = lambda: BasetenDecisionClient("")
    item = capture()
    try:
        with TestClient(app) as client:
            client.post("/learning/identity")
            client.post("/learning/sessions", json={"session_id": str(item.session_id)})
            client.post(f"/learning/sessions/{item.session_id}/attempts", json=item.attempt.model_dump(mode="json"))
            path = f"/learning/attempts/{item.attempt.attempt_id}/assess"
            first = client.post(path)
            assert first.status_code == 200
            for _ in range(5):
                assert client.post(path).json() == first.json()
            with store.engine.connect() as conn:
                assert conn.scalar(select(func.count()).select_from(evaluations)) == 1
                assert conn.scalar(select(func.count()).select_from(budgets)) == 0
                assert conn.scalar(select(attempts.c.run_count)) == 0
            provider = BasetenDecisionClient("test", transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json=response(BASETEN_MODELS["elephant"])) ))
            app.dependency_overrides[get_provider] = lambda: provider
            assessed = client.post(path)
            assert assessed.status_code == 200
            assert assessed.json()["assessment"]["provider_error"] is None
            assert assessed.json()["assessment"]["observations"][0]["provider"] == "baseten"
            assert assessed.headers["cache-control"] == "no-store"
            with store.engine.connect() as conn:
                assert conn.scalar(select(func.count()).select_from(evaluations)) == 2
                assert conn.scalar(select(attempts.c.run_count)) == 1
    finally:
        store.engine.dispose()


def test_preflight_reports_selected_provider_without_a_live_call(monkeypatch):
    from scripts.learning_preflight import preflight
    monkeypatch.setenv("DECISION_PROVIDER", "baseten")
    monkeypatch.setenv("BASETEN_DECISION_MODEL", BASETEN_MODELS["mammoth"])
    monkeypatch.setenv("BASETEN_API_KEY", "configured-but-unused")
    monkeypatch.delenv("LEARNING_DATABASE_URL", raising=False)
    report = asyncio.run(preflight(False, False))
    assert report["decision_provider"] == "baseten"
    assert report["decision_model"] == BASETEN_MODELS["mammoth"]
    assert report["decision_configured"] is True
    assert "configured-but-unused" not in json.dumps(report)
    assert "decision" not in report  # No fabricated live result.
