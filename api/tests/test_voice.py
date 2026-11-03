import io
import json
import wave
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import learning.voice_router as voice
from learning.board_contracts import Edit, EditBatch, Element
from learning.board_router import router as board_router
from learning.board_storage import BoardStore
from learning.router import COOKIE, get_store, router
from learning.storage import CaptureStore, make_engine
from learning.tutor_storage import TutorStore
from transcription import MUSE_MODEL, MuseTranscriber, keyword_hints


def wav(seconds=1.0, rate=16_000) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x01\x00" * int(seconds * rate))
    return out.getvalue()


class Provider:
    """Scripted Muse endpoint over httpx.MockTransport; records every request."""

    def __init__(self, reply=None):
        self.reply = reply or (lambda request: httpx.Response(200, json={"transcript": " Why  divide by root d k? ", "turns": []}))
        self.requests = []

    def __call__(self, request: httpx.Request):
        self.requests.append(request)
        return self.reply(request)

    def parts(self, index=-1) -> dict:
        request = self.requests[index]
        boundary = request.headers["content-type"].split("boundary=")[1].encode()
        out = {}
        for chunk in request.content.split(b"--" + boundary)[1:-1]:
            head, body = chunk.split(b"\r\n\r\n", 1)
            name = head.split(b'name="')[1].split(b'"')[0].decode()
            out[name] = body[:-2]
        return out


@pytest.fixture
def env(tmp_path, monkeypatch):
    capture = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'voice.db').as_posix()}"))
    capture.initialize()
    token = capture.issue_identity()
    owner = capture.owner_for_token(token)
    sid = uuid4()
    capture.create_session(owner, sid)
    provider = Provider()
    holder = {"key": "test-key"}

    async def transcriber():
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            yield MuseTranscriber(client, api_key=holder["key"])

    app = FastAPI()
    app.include_router(router)
    app.include_router(board_router)
    app.include_router(voice.router)
    app.dependency_overrides[get_store] = lambda: capture
    app.dependency_overrides[voice.get_transcriber] = transcriber
    cloud = {"speech": voice.DeepgramSpeech(httpx.AsyncClient(), api_key="")}
    app.dependency_overrides[voice.get_cloud_speech] = lambda: cloud["speech"]
    app.state.cloud = cloud
    client = TestClient(app)
    client.cookies.set(COOKIE, token)
    yield client, capture, owner, sid, provider, holder
    capture.engine.dispose()


def post(client, sid, audio, content_type="audio/wav"):
    return client.post(f"/learning/sessions/{sid}/transcribe", content=audio, headers={"Content-Type": content_type})


def test_sends_contract_with_board_keywords(env):
    client, capture, owner, sid, provider, _ = env
    BoardStore(capture).apply(owner, sid, EditBatch(operation_id=uuid4(), expected_revision=0, edits=[
        Edit(element=Element(id="w", type="text", x=0, y=0, width=200, height=40, text="softmax saturates for large d_k"), actor="human")]))
    store = TutorStore(capture)
    turn = str(uuid4())
    store.begin(owner, str(sid), turn, "question", {"text": "q"}, "h")
    store.finish(turn, "done", [{"type": "seg", "id": "s1", "goal": "Why scale attention"},
                                {"type": "equation", "latex": "\\text{GEPA} = \\lambda"}], None, None, {})

    response = post(client, sid, wav(1.5, 16_000))
    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "Why divide by root d k?" and body["model"] == MUSE_MODEL and body["duration"] == 1.5
    parts = provider.parts()
    request = json.loads(parts["request"])
    assert {k: request[k] for k in ("model", "audioEncoding", "sampleRateHertz")} == {
        "model": MUSE_MODEL, "audioEncoding": "WAV", "sampleRateHertz": 16_000}
    # Newest turns first (moves in order), then the board's own text; filler words dropped.
    assert request["keywords"][:4] == ["scale", "attention", "GEPA", "lambda"]
    assert {"softmax", "saturates", "d_k"} <= set(request["keywords"])
    assert parts["audio"] == wav(1.5, 16_000)
    assert provider.requests[-1].headers["authorization"] == "Bearer test-key"


def test_reads_sample_rate_from_header(env):
    client, _, _, sid, provider, _ = env
    assert post(client, sid, wav(1, 24_000)).status_code == 200
    request = json.loads(provider.parts()["request"])
    assert request["sampleRateHertz"] == 24_000 and "keywords" not in request


@pytest.mark.parametrize("audio,content_type,status,code", [
    (wav(1), "application/json", 415, "audio_invalid"),
    (b"RIFF not really a wav", "audio/wav", 415, "audio_invalid"),
    (wav(0.1), "audio/wav", 422, "no_speech"),
    (wav(32, 8_000), "audio/wav", 413, "audio_too_long"),
    (b"\0" * 1_100_001, "audio/wav", 413, "audio_too_large"),
], ids=["content_type", "not_wav", "too_short", "too_long", "too_large"])
def test_rejects_bad_audio_before_any_paid_call(env, audio, content_type, status, code):
    client, _, _, sid, provider, _ = env
    response = post(client, sid, audio, content_type)
    assert (response.status_code, response.json()["detail"]) == (status, code)
    assert provider.requests == []


@pytest.mark.parametrize("reply,status,code", [
    (lambda r: httpx.Response(401, json={}), 502, "transcribe_auth_failed"),
    (lambda r: httpx.Response(429, json={}), 429, "transcribe_rate_limited"),
    (lambda r: httpx.Response(500, text="boom"), 502, "transcribe_failed"),
    (lambda r: httpx.Response(200, json={"transcript": "   "}), 422, "no_speech"),
    (lambda r: httpx.Response(200, text="not json"), 502, "transcribe_failed"),
])
def test_maps_provider_errors(env, reply, status, code):
    client, _, _, sid, provider, _ = env
    provider.reply = reply
    response = post(client, sid, wav())
    assert (response.status_code, response.json()["detail"]) == (status, code)


def test_timeout_maps_and_does_not_retry(env):
    client, _, _, sid, provider, _ = env

    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)
    provider.reply = slow
    response = post(client, sid, wav())
    assert (response.status_code, response.json()["detail"]) == (504, "transcribe_timeout")
    assert len(provider.requests) == 1


def test_missing_key_is_503_without_a_call(env):
    client, _, _, sid, provider, holder = env
    holder["key"] = ""
    response = post(client, sid, wav())
    assert (response.status_code, response.json()["detail"]) == (503, "transcribe_not_configured")
    assert provider.requests == []


def test_requires_identity_and_ownership(env):
    client, capture, _, _, provider, _ = env
    other = capture.owner_for_token(capture.issue_identity())
    foreign = uuid4()
    capture.create_session(other, foreign)
    assert post(client, foreign, wav()).status_code == 404
    client.cookies.clear()
    assert post(client, foreign, wav()).status_code == 401
    assert provider.requests == []


def test_hourly_budget(env, monkeypatch):
    client, _, _, sid, provider, _ = env
    monkeypatch.setattr(voice, "HOURLY_TRANSCRIPTIONS", 2)
    assert [post(client, sid, wav()).status_code for _ in range(3)] == [200, 200, 429]
    assert len(provider.requests) == 2


def test_warm_opens_a_connection(env):
    client, _, _, sid, provider, _ = env
    assert client.post(f"/learning/sessions/{sid}/transcribe/warm").status_code == 204
    assert provider.requests[-1].method == "HEAD"


def test_keyword_hints_dedupe_filter_and_cap():
    terms = keyword_hints(["Attention attention ATTENTION", "\\frac{QK^T}{\\sqrt{d_k}} \\text{softmax}", "the and with what"])
    assert terms == ["Attention", "QK", "d_k", "softmax"]
    assert len(keyword_hints([f"term{i}x" for i in range(100)])) == 30


class FakeEngine:
    def __init__(self, available=True):
        self.available, self.calls = available, []

    async def synthesize(self, text, voice_name, speed):
        self.calls.append((text, voice_name, speed))
        return wav(0.5, 24_000), {"voice": voice_name, "cached": False}


def test_speech_serves_kokoro_behind_identity(env, monkeypatch):
    client, *_ = env
    engine = FakeEngine()
    monkeypatch.setattr(voice, "get_speech_engine", lambda: engine)
    response = client.post("/learning/speech", json={"text": "Look at the board.", "voice": "kokoro_af_heart"})
    assert response.status_code == 200 and response.headers["content-type"] == "audio/wav"
    assert response.headers["x-speech-voice"] == "kokoro_af_heart" and response.content[:4] == b"RIFF"
    assert client.post("/learning/speech", json={"text": "x" * 501}).status_code == 422
    client.cookies.clear()
    assert client.post("/learning/speech", json={"text": "hi"}).status_code == 401
    assert len(engine.calls) == 1


def test_speech_unavailable_is_503(env, monkeypatch):
    client, *_ = env
    monkeypatch.setattr(voice, "get_speech_engine", lambda: FakeEngine(available=False))
    response = client.post("/learning/speech", json={"text": "hello"})
    assert (response.status_code, response.json()["detail"]) == (503, "speech_unavailable")


def deepgram(reply):
    """A DeepgramSpeech over a scripted transport; returns (speech, requests)."""
    requests = []

    def handler(request):
        requests.append(request)
        return reply(request)
    return voice.DeepgramSpeech(httpx.AsyncClient(transport=httpx.MockTransport(handler)), api_key="dg-test"), requests


def test_speech_prefers_deepgram_and_maps_the_voice(env, monkeypatch):
    client, *_ = env
    engine = FakeEngine()
    monkeypatch.setattr(voice, "get_speech_engine", lambda: engine)
    speech, requests = deepgram(lambda request: httpx.Response(200, content=wav(0.3, 24_000)))
    client.app.state.cloud["speech"] = speech
    response = client.post("/learning/speech", json={"text": "Look at the board.", "voice": "kokoro_am_michael"})
    assert response.status_code == 200 and response.headers["x-speech-engine"] == "deepgram"
    # The browser checks the served voice against the requested picker id.
    assert response.headers["x-speech-voice"] == "kokoro_am_michael" and response.content[:4] == b"RIFF"
    sent = requests[0]
    assert sent.url.params["model"] == "aura-2-apollo-en" and sent.url.params["container"] == "wav"
    assert sent.headers["authorization"] == "Token dg-test" and json.loads(sent.content) == {"text": "Look at the board."}
    assert engine.calls == []


@pytest.mark.parametrize("reply", [lambda r: httpx.Response(500), lambda r: httpx.Response(200, content=b"not audio"),
                                   lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow"))])
def test_deepgram_failure_falls_back_to_kokoro(env, monkeypatch, reply):
    client, *_ = env
    engine = FakeEngine()
    monkeypatch.setattr(voice, "get_speech_engine", lambda: engine)
    client.app.state.cloud["speech"] = deepgram(reply)[0]
    response = client.post("/learning/speech", json={"text": "hello", "voice": "kokoro_af_heart"})
    assert response.status_code == 200 and response.headers["x-speech-engine"] == "kokoro"
    assert len(engine.calls) == 1


def test_speech_budget_past_the_cap_uses_kokoro_without_a_paid_call(env, monkeypatch):
    client, *_ = env
    engine = FakeEngine()
    monkeypatch.setattr(voice, "get_speech_engine", lambda: engine)
    monkeypatch.setattr(voice, "HOURLY_SPEECH", 1)
    speech, requests = deepgram(lambda request: httpx.Response(200, content=wav(0.3, 24_000)))
    client.app.state.cloud["speech"] = speech
    engines = [client.post("/learning/speech", json={"text": f"line {i}"}).headers["x-speech-engine"] for i in range(2)]
    assert engines == ["deepgram", "kokoro"] and len(requests) == 1


def test_transcription_budget_is_shared_across_instances(env, monkeypatch):
    """The cap lives in the database, so a second API process sees the same count."""
    client, capture, owner, sid, provider, _ = env
    monkeypatch.setattr(voice, "HOURLY_TRANSCRIPTIONS", 1)
    assert post(client, sid, wav()).status_code == 200
    from learning.storage import StoreError
    with pytest.raises(StoreError) as caught:
        capture.charge("transcribe", owner, 1, 600)
    assert caught.value.code == "transcribe_budget_exhausted"
