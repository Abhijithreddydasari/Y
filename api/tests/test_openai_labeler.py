"""H5 step 1: the OpenAI Decisions API as an evidence labeler, and learner ink crops as image evidence (mocked)."""
import asyncio
import base64
import json
from io import BytesIO
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from learning import observations
from learning.board_contracts import ContextInput, Crop, Rect
from learning.board_storage import BoardStore
from learning.decisions import (EVIDENCE_QUESTIONS, BasetenEvidenceLabeler, OpenAIEvidenceLabeler, ProviderFailure,
                                evidence_labeler)
from learning.tutor_router import ink_crops
from learning.tutor_turn import TurnInput
from test_evidence import FREE, FakeLabeler, _scene, answer, settled, waiting  # noqa: F401
from test_tutor_turn import env, events  # noqa: F401

ASKED = {"outcome": EVIDENCE_QUESTIONS["outcome"], "key_valid": EVIDENCE_QUESTIONS["key_valid"]}


@pytest.fixture(autouse=True)
def one_loop(env):
    with env[0]:
        yield


def png(color="white"):
    out = BytesIO()
    Image.new("RGB", (40, 30), color).save(out, format="PNG")
    return out.getvalue()


def choice(name, pick, table, confidence=0.8):
    return {"type": "choice", "name": name, "choice": pick, "confidence": confidence,
            "probabilities": [{"value": v, "probability": p} for v, p in table.items()]}


OK = {"model": "gpt-6-luna", "usage": {"input_tokens": 120, "output_tokens": 0, "total_tokens": 120},
      "answers": [choice("outcome", "partial", {"correct": 0.1, "partial": 0.7, "incorrect": 0.15, "unanswered": 0.05}),
                  choice("key_valid", "valid", {"valid": 0.9, "invalid": 0.05, "unsure": 0.05})]}


def client(handler, **kw):
    return OpenAIEvidenceLabeler("sk-test", transport=httpx.MockTransport(handler), **kw)


def test_request_shape_auth_and_answer_mapping():
    sent = {}

    def handler(request):
        sent.update(url=str(request.url), auth=request.headers["authorization"], body=json.loads(request.content))
        return httpx.Response(200, json=OK)

    result, raw = asyncio.run(client(handler).label({"learner_answer": "x"}, ASKED))
    assert sent["url"] == "https://api.openai.com/v1/decisions" and sent["auth"] == "Bearer sk-test"
    body = sent["body"]
    assert body["model"] == "gpt-6-luna" and [q["name"] for q in body["questions"]] == ["outcome", "key_valid"]
    assert all(q["type"] == "choice" and "untrusted" in q["instructions"] for q in body["questions"])
    assert [c["value"] for c in body["questions"][0]["choices"]] == list(ASKED["outcome"][1])
    developer, user = body["input"]
    assert developer["role"] == "developer" and "untrusted" in developer["content"][0]["text"]
    assert user["content"] == [{"type": "input_json", "data": {"state": {"learner_answer": "x"}}}]  # no image without ink
    assert result.answers["outcome"].choice == "partial" and result.answers["outcome"].probabilities["partial"] == 0.7
    assert result.usage.input_tokens == 120 and raw == OK


def test_images_are_data_urls_and_capped_at_two():
    sent = {}

    def handler(request):
        sent.update(json.loads(request.content))
        return httpx.Response(200, json=OK)

    images = tuple(("image/png", png(c)) for c in ("white", "black", "red"))
    asyncio.run(client(handler).label({}, ASKED, images))
    parts = sent["input"][1]["content"]
    pictures = [p for p in parts if p["type"] == "input_image"]
    assert len(pictures) == 2 and all(p["detail"] == "high" for p in pictures)
    assert pictures[0]["image_url"] == "data:image/png;base64," + base64.b64encode(images[0][1]).decode()


def test_refusal_leaves_only_that_field_open_and_snapshot_names_are_accepted():
    refused = {**OK, "model": "gpt-6-luna-2026-10-01",
               "answers": [OK["answers"][0], {"type": "refusal", "name": "key_valid"}]}
    result, _ = asyncio.run(client(lambda r: httpx.Response(200, json=refused)).label({}, ASKED))
    assert set(result.answers) == {"outcome"}


BAD_OPTION = {**OK, "answers": [choice("outcome", "maybe", {"maybe": 1.0}), OK["answers"][1]]}
SHORT = {**OK, "answers": OK["answers"][:1]}
OTHER_MODEL = {**OK, "model": "gpt-6-terra"}


@pytest.mark.parametrize("response,code", [
    (httpx.Response(401, json={"error": {"message": "bad key"}}), "provider_auth_failed"),
    (httpx.Response(403), "provider_auth_failed"),
    (httpx.Response(429), "provider_rate_limited"),
    (httpx.Response(500), "provider_http_error"),
    (httpx.Response(200, content=b"{\"answers\": ["), "provider_invalid_response"),
    (httpx.Response(200, json=BAD_OPTION), "provider_invalid_response"),
    (httpx.Response(200, json=SHORT), "provider_invalid_response"),
    (httpx.Response(200, json=OTHER_MODEL), "provider_model_mismatch"),
])
def test_failures_map_to_safe_codes(response, code):
    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(client(lambda request: response).label({}, ASKED))
    assert raised.value.code == code


def test_timeout_missing_key_and_http_base():
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(client(slow).label({}, ASKED))
    assert raised.value.code == "provider_timeout"
    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(OpenAIEvidenceLabeler(" ").label({}, ASKED))
    assert raised.value.code == "provider_not_configured"
    with pytest.raises(ValueError):
        OpenAIEvidenceLabeler("k", base_url="http://example.com/v1")


def test_provider_is_selected_explicitly_from_the_environment(monkeypatch):
    for name in ("EVIDENCE_LABEL_PROVIDER", "EVIDENCE_LABEL_MODEL", "OPENAI_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    assert not isinstance(evidence_labeler(), OpenAIEvidenceLabeler)  # a key alone never selects a non-Meta labeler
    monkeypatch.setenv("EVIDENCE_LABEL_PROVIDER", "baseten")
    assert isinstance(evidence_labeler(), BasetenEvidenceLabeler)
    monkeypatch.setenv("EVIDENCE_LABEL_PROVIDER", "openai")
    chosen = evidence_labeler()
    assert isinstance(chosen, OpenAIEvidenceLabeler) and chosen.configured and chosen.model == "gpt-6-luna"
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example.com/v1/")
    monkeypatch.setenv("EVIDENCE_LABEL_MODEL", "gpt-6-luna-2026-10-01")
    chosen = evidence_labeler()
    assert chosen.endpoint == "https://proxy.example.com/v1/decisions" and chosen.model == "gpt-6-luna-2026-10-01"
    monkeypatch.setenv("EVIDENCE_LABEL_PROVIDER", "gemini")
    with pytest.raises(ValueError):
        evidence_labeler()


# --- learner ink crops ----------------------------------------------------------------------------

def _crop(key, ids):
    return Crop(asset_hash=key, bounds=Rect(x=0, y=0, w=10, h=10), element_ids=ids)


def test_only_crops_made_of_the_answers_own_ink_are_kept():
    board = ContextInput(request_id=uuid4(), revision=1, crops=[
        _crop("a" * 64, ["my-ink"]), _crop("b" * 64, ["my-ink", "tutor-ink"]), _crop("c" * 64, ["my-ink", "more"]),
        _crop("d" * 64, ["more"])])
    body = TurnInput(turn_id=uuid4(), kind="answer", question_id="q", text="x", via="ink",
                     element_ids=("my-ink", "more"), board=board)
    assert ink_crops(body) == ("a" * 64, "c" * 64)  # mixed with tutor ink: never sent; at most two
    typed = TurnInput(turn_id=uuid4(), kind="answer", question_id="q", text="x", board=board)
    assert ink_crops(typed) == ()


def test_ink_answer_sends_its_stored_crops_to_the_labeler(env):
    client_, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler({"outcome": "correct"})
    labeler.provider_name = "openai"
    boards = BoardStore(capture)
    boards.load(owner, sid)
    _scene(capture, owner, sid, "human", "my-ink")
    asset = boards.put_asset(owner, str(sid), png("black"))
    row, created = observations.ObservationStore(capture).capture_answer(
        owner, str(sid), str(uuid4()), {"qid": "t.9", "kind": "free", "q": "Sketch it", "key": "a parabola", "options": [],
                                        "concept": "curves", "dim": "apply"},
        "parabola", {"result": "unverified", "verified": None}, "ink", [], ("my-ink",), (asset["hash"], "e" * 64))
    store = observations.ObservationStore(capture)
    client_.portal.call(observations.label, store, labeler, owner, row["observation_id"])
    [stored] = settled(client_, sid)
    assert len(labeler.images) == 1 and labeler.images[0][0] == "image/png"  # the missing asset is skipped
    assert stored["observation"]["labeler"] == "openai" and stored["fields"]["outcome"]["source"] == "openai"
