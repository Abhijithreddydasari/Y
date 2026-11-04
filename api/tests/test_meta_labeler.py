"""The Meta chat labeler: same typed answers as a decision API, from strict JSON (mocked; no provider is reached)."""
from __future__ import annotations

import asyncio
import base64
import json
from io import BytesIO
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from learning import observations
from learning.board_storage import BoardStore
from learning.decisions import (BASETEN_CHAT_BASE, EVIDENCE_QUESTIONS, ChatEvidenceLabeler, ProviderFailure,
                                SPARK_OPEN_LABEL_MODEL, evidence_labeler)
from test_evidence import _scene, settled  # noqa: F401
from test_tutor_turn import env, events  # noqa: F401

STATE = {"question": "2 + 2?", "options": [], "answer_key": "4", "learner_answer": "5", "answer_format": "typed"}
ASKED = {"outcome": EVIDENCE_QUESTIONS["outcome"],
         "misconception": ("Which?", {"none": "none", "other": "another", "c/adds-one": "adds one"})}
GOOD = {"outcome": {"correct": 0.05, "partial": 0.05, "incorrect": 0.85, "unanswered": 0.05},
        "misconception": {"none": 0.1, "other": 0.2, "c/adds-one": 0.7}}


def envelope(content, model="muse-spark-1.3"):
    return {"model": model, "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            "choices": [{"message": {"content": content if isinstance(content, str) else json.dumps(content)}}]}


def labeler(reply, seen=None, status=200, **kwargs):
    def handle(request):
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=reply)
    return ChatEvidenceLabeler("k", transport=httpx.MockTransport(handle), **kwargs)


def run(client, images=()):
    return asyncio.run(client.label(STATE, ASKED, images))


def test_returns_typed_answers_with_usage_and_model():
    response, _raw = run(labeler(envelope(GOOD)))
    assert response.answers["outcome"].choice == "incorrect"
    assert response.answers["misconception"].probabilities["c/adds-one"] == pytest.approx(0.7)
    assert response.usage.input_tokens == 10 and response.model == "muse-spark-1.3"


def test_weights_are_normalized_when_they_do_not_sum_to_one():
    reply = {**GOOD, "outcome": {"correct": 10, "partial": 10, "incorrect": 70, "unanswered": 10}}
    response, _raw = run(labeler(envelope(reply)))
    assert response.answers["outcome"].probabilities["incorrect"] == pytest.approx(0.7)
    assert sum(response.answers["outcome"].probabilities.values()) == pytest.approx(1)


def test_request_is_a_strict_schema_with_every_option_required():
    seen = []
    run(labeler(envelope(GOOD), seen))
    body = json.loads(seen[0].content)
    schema = body["response_format"]["json_schema"]
    assert schema["strict"] is True and schema["schema"]["additionalProperties"] is False
    assert set(schema["schema"]["required"]) == set(ASKED)
    assert set(schema["schema"]["properties"]["misconception"]["required"]) == {"none", "other", "c/adds-one"}
    assert body["reasoning_effort"] == "minimal" and seen[0].headers["authorization"] == "Bearer k"
    assert "untrusted" in body["messages"][0]["content"]


def test_ink_crops_are_sent_as_images_at_most_two():
    seen = []
    run(labeler(envelope(GOOD), seen), (("image/png", b"one"), ("image/png", b"two"), ("image/png", b"three")))
    parts = json.loads(seen[0].content)["messages"][1]["content"]
    images = [p for p in parts if p["type"] == "image_url"]
    assert len(images) == 2
    assert images[0]["image_url"]["url"] == "data:image/png;base64," + base64.b64encode(b"one").decode()


@pytest.mark.parametrize("reply", [
    "", "not json", {"outcome": GOOD["outcome"]},
    {**GOOD, "outcome": {"correct": 1}},
    {**GOOD, "outcome": {"correct": 0, "partial": 0, "incorrect": 0, "unanswered": 0}},
    {**GOOD, "outcome": {"correct": -1, "partial": 1, "incorrect": 1, "unanswered": 0}},
    {**GOOD, "outcome": {"correct": True, "partial": 0, "incorrect": 0, "unanswered": 0}},
])
def test_a_malformed_reply_is_invalid_never_a_guess(reply):
    with pytest.raises(ProviderFailure) as failure:
        run(labeler(envelope(reply)))
    assert failure.value.code == "provider_invalid_response"


@pytest.mark.parametrize("status,code", [(401, "provider_auth_failed"), (403, "provider_auth_failed"),
                                         (429, "provider_rate_limited"), (500, "provider_http_error")])
def test_status_codes_map_to_the_shared_failure_codes(status, code):
    with pytest.raises(ProviderFailure) as failure:
        run(labeler({}, status=status))
    assert failure.value.code == code


def test_a_different_model_in_the_reply_is_refused():
    with pytest.raises(ProviderFailure) as failure:
        run(labeler(envelope(GOOD, model="other-model")))
    assert failure.value.code == "provider_model_mismatch"


def test_no_key_never_calls_the_provider():
    seen = []
    unset = ChatEvidenceLabeler("", transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200)))
    assert unset.configured is False
    with pytest.raises(ProviderFailure) as failure:
        run(unset)
    assert failure.value.code == "provider_not_configured" and not seen


def test_default_is_spark_open_on_baseten_with_no_setting(monkeypatch):
    for name in ("EVIDENCE_LABEL_PROVIDER", "EVIDENCE_LABEL_MODEL", "EVIDENCE_LABEL_EFFORT", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BASETEN_API_KEY", "b")
    chosen = evidence_labeler()
    assert isinstance(chosen, ChatEvidenceLabeler) and chosen.configured
    assert chosen.model == SPARK_OPEN_LABEL_MODEL and chosen.effort == "minimal"
    assert chosen.provider_name == "baseten" and chosen.endpoint.startswith(BASETEN_CHAT_BASE)


def test_a_missing_baseten_key_does_not_fall_back_to_another_provider(monkeypatch):
    for name in ("EVIDENCE_LABEL_PROVIDER", "EVIDENCE_LABEL_MODEL", "BASETEN_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    monkeypatch.setenv("MODEL_API_KEY", "m")
    chosen = evidence_labeler()
    assert chosen.model == SPARK_OPEN_LABEL_MODEL and chosen.configured is False


def test_meta_provider_uses_the_meta_key(monkeypatch):
    monkeypatch.setenv("EVIDENCE_LABEL_PROVIDER", "meta")
    monkeypatch.delenv("EVIDENCE_LABEL_MODEL", raising=False)
    monkeypatch.setenv("MODEL_API_KEY", "m")
    chosen = evidence_labeler()
    assert chosen.provider_name == "meta" and chosen.model == "muse-spark-1.3" and chosen.configured


def test_ink_answer_is_labeled_end_to_end_with_provider_and_model_on_the_row(env):
    """Through the real store and `observations.label`: the crop reaches the request, and the row records who labeled it."""
    client_, capture, owner, sid, holder = env
    sent = []

    def handle(request):
        body = json.loads(request.content)
        sent.append(body)
        schema = body["response_format"]["json_schema"]["schema"]["properties"]
        # All mass on "partial" where it exists, else on the first listed option.
        reply = {name: {opt: (1 if opt == ("partial" if "partial" in spec["required"] else spec["required"][0]) else 0)
                        for opt in spec["required"]} for name, spec in schema.items()}
        return httpx.Response(200, json=envelope(reply, model=SPARK_OPEN_LABEL_MODEL))

    chat = ChatEvidenceLabeler("k", provider_name="baseten", model=SPARK_OPEN_LABEL_MODEL, transport=httpx.MockTransport(handle))
    boards = BoardStore(capture)
    boards.load(owner, sid)
    _scene(capture, owner, sid, "human", "my-ink")
    out = BytesIO()
    Image.new("RGB", (40, 30), "black").save(out, format="PNG")
    asset = boards.put_asset(owner, str(sid), out.getvalue())
    store = observations.ObservationStore(capture)
    row, _created = store.capture_answer(
        owner, str(sid), str(uuid4()), {"qid": "t.9", "kind": "free", "q": "Sketch it", "key": "a parabola", "options": [],
                                        "concept": "curves", "dim": "apply"},
        "(answered in ink)", {"result": "unverified", "verified": None}, "ink", [], ("my-ink",), (asset["hash"],))
    with client_:
        client_.portal.call(observations.label, store, chat, owner, row["observation_id"])
        [stored] = settled(client_, sid)
    assert [p["type"] for p in sent[0]["messages"][1]["content"]] == ["text", "image_url"]
    assert stored["status"] == "labeled" and stored["observation"]["outcome"] == "partial"
    assert stored["observation"]["labeler"] == "baseten" and stored["fields"]["outcome"]["source"] == "baseten"
    assert stored["observation"]["outcome_p"]["partial"] == 1
