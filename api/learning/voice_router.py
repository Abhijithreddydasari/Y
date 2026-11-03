"""Voice for the tutor: push-to-talk transcription in, Kokoro narration out.

Transcription proxies Muse Voice Transcribe so the key stays server-side; keyword hints come from the
session's own board and tutor history, never from the request. Speech goes to Deepgram Aura when
DEEPGRAM_API_KEY is set (hosted, first audio well under Kokoro's CPU time), else or on failure to the existing
Kokoro engine (Moonshine Voice, ONNX on CPU), behind the same identity cookie, so the web needs no public API base.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from speech import DEFAULT_VOICE, SpeechError, get_speech_engine
from transcription import MAX_WAV_BYTES, MuseTranscriber, TranscribeFailure, keyword_hints

from .board_router import get_board_store
from .router import call_store, get_store, private_response, require_owner
from .storage import limit
from .tutor_router import get_tutor_store

router = APIRouter(prefix="/learning", tags=["voice"], dependencies=[Depends(private_response)])
log = logging.getLogger("y.voice")
HOURLY_TRANSCRIPTIONS, HOURLY_TRANSCRIPTIONS_GLOBAL = limit("TRANSCRIBE_OWNER", 120), limit("TRANSCRIBE_GLOBAL", 600)
HOURLY_SPEECH, HOURLY_SPEECH_GLOBAL = limit("SPEECH_OWNER", 600), limit("SPEECH_GLOBAL", 6000)
DEEPGRAM_URL = "https://api.deepgram.com/v1/speak"
DEEPGRAM_SECONDS = 4.0  # past this Kokoro answers instead
# The picker keeps its Kokoro ids; each maps to the nearest Aura voice.
AURA_VOICES = {"kokoro_af_heart": "aura-2-thalia-en", "kokoro_am_michael": "aura-2-apollo-en"}
STATUS = {"transcribe_not_configured": 503, "transcribe_auth_failed": 502, "transcribe_rate_limited": 429,
          "transcribe_timeout": 504, "transcribe_failed": 502, "no_speech": 422, "audio_invalid": 415,
          "audio_too_large": 413, "audio_too_long": 413}
_provider_slots = asyncio.Semaphore(4)
_speech_slots = asyncio.Semaphore(int(os.environ.get("SPEECH_SLOTS", "2")))


async def get_transcriber(request: Request):
    client = getattr(request.app.state, "board_http", None)
    if client is not None:
        yield MuseTranscriber(client)
    else:
        async with httpx.AsyncClient() as client:
            yield MuseTranscriber(client)


class DeepgramSpeech:
    """Deepgram Aura text to speech, WAV out. Failures raise SpeechError so Kokoro can answer instead."""

    def __init__(self, client: httpx.AsyncClient, api_key: str | None = None):
        self.client = client
        self.api_key = (os.environ.get("DEEPGRAM_API_KEY", "") if api_key is None else api_key).strip()

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def synthesize(self, text: str, voice: str) -> bytes:
        params = {"model": AURA_VOICES.get(voice, AURA_VOICES[DEFAULT_VOICE]), "encoding": "linear16",
                  "container": "wav", "sample_rate": "24000"}
        try:
            response = await self.client.post(DEEPGRAM_URL, params=params, json={"text": text}, timeout=DEEPGRAM_SECONDS,
                                              headers={"Authorization": f"Token {self.api_key}"})
        except httpx.HTTPError as exc:
            raise SpeechError(f"deepgram {type(exc).__name__}") from exc
        if response.status_code != 200 or response.content[:4] != b"RIFF":
            raise SpeechError(f"deepgram status {response.status_code}")
        return response.content


async def get_cloud_speech(request: Request):
    client = getattr(request.app.state, "board_http", None)
    if client is not None:
        yield DeepgramSpeech(client)
    else:
        async with httpx.AsyncClient() as client:
            yield DeepgramSpeech(client)


def board_terms(board: dict, history: list[dict]) -> list[str]:
    """Hint sources, newest first: recent segment goals and equations, then text and equations on the board."""
    texts: list[str] = []
    for turn in reversed(history[-6:]):
        texts += [m.get("goal") or m.get("latex") or "" for m in turn["moves"] if m["type"] in ("seg", "equation")]
    for record in board.get("records", {}).values():
        element = record.get("element", {})
        if element.get("isDeleted"):
            continue
        semantic = (element.get("customData") or {}).get("ySemantic") or {}
        texts.append(element.get("text") or semantic.get("latex") or "")
    return keyword_hints(texts)


async def _read_wav(request: Request) -> bytes:
    if (request.headers.get("content-type") or "").split(";")[0].strip().lower() not in ("audio/wav", "audio/x-wav", "audio/wave"):
        raise HTTPException(415, "audio_invalid")
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_WAV_BYTES:
            raise HTTPException(413, "audio_too_large")
    return bytes(body)


@router.post("/sessions/{sid}/transcribe/warm", status_code=204)
async def warm(sid: UUID, owner=Depends(require_owner), transcriber=Depends(get_transcriber)):
    await transcriber.warm()
    return Response(status_code=204)


@router.post("/sessions/{sid}/transcribe")
async def transcribe(sid: UUID, request: Request, owner=Depends(require_owner), boards=Depends(get_board_store),
                     turns=Depends(get_tutor_store), transcriber=Depends(get_transcriber), capture=Depends(get_store)):
    started = time.perf_counter()
    if not transcriber.configured:
        raise HTTPException(503, "transcribe_not_configured")
    audio = await _read_wav(request)
    # Loading the board also checks that the session belongs to this owner, before any paid call.
    board = await call_store(boards.load, owner, sid)
    history = await call_store(turns.history, owner, str(sid))
    keywords = board_terms(board, history)
    # DB-backed, so the cap holds across containers; a paid call is never made past it.
    await call_store(capture.charge, "transcribe", owner, HOURLY_TRANSCRIPTIONS, HOURLY_TRANSCRIPTIONS_GLOBAL)
    try:
        async with _provider_slots:
            result = await transcriber.transcribe(audio, keywords)
    except TranscribeFailure as exc:
        log.info("transcribe failed code=%s bytes=%s", exc.code, len(audio))
        raise HTTPException(STATUS.get(exc.code, 502), exc.code) from exc
    timing = {"provider_ms": round(transcriber.timing.get("provider_ms", 0)), "total_ms": round((time.perf_counter() - started) * 1000)}
    log.info("transcribe ok bytes=%s duration=%s keywords=%s timing=%s", len(audio), result["duration"], result["keywords"], timing)
    return {**result, "timing": timing}


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=0.8, le=1.2)


@router.post("/speech")
async def speech(body: SpeechInput, owner=Depends(require_owner), capture=Depends(get_store),
                 cloud=Depends(get_cloud_speech)):
    started = time.perf_counter()
    if cloud.configured:
        try:
            # Past the paid budget the free Kokoro voice still answers.
            await call_store(capture.charge, "speech", owner, HOURLY_SPEECH, HOURLY_SPEECH_GLOBAL)
            # Aura has no speed control; the picker's rate applies to Kokoro and the browser voice only.
            audio = await cloud.synthesize(body.text, body.voice)
            return _audio(audio, body.voice, "deepgram", False, started)
        except HTTPException:
            log.warning("speech budget exhausted, using Kokoro")
        except SpeechError as exc:
            log.warning("deepgram speech failed, using Kokoro: %s", exc)
    engine = get_speech_engine()
    if not engine.available:
        raise HTTPException(503, "speech_unavailable")
    try:
        async with _speech_slots:
            audio, metadata = await engine.synthesize(body.text, body.voice, body.speed)
    except SpeechError as exc:
        raise HTTPException(503 if not engine.available else 422, "speech_failed") from exc
    return _audio(audio, str(metadata.get("voice", body.voice)), "kokoro", bool(metadata.get("cached")), started)


def _audio(audio: bytes, voice: str, engine: str, cached: bool, started: float) -> Response:
    return Response(content=audio, media_type="audio/wav", headers={
        "X-Speech-Voice": voice, "X-Speech-Engine": engine, "X-Speech-Cache": "hit" if cached else "miss",
        "X-Speech-Ms": str(round((time.perf_counter() - started) * 1000)), "Cache-Control": "no-store"})


async def prefetch_speech() -> None:
    """Load Kokoro voices at startup when SPEECH_PREFETCH=1 so the first narration is not cold."""
    if os.environ.get("SPEECH_PREFETCH") != "1":
        return
    try:
        await get_speech_engine().prefetch()
    except Exception as exc:  # optional: narration falls back to browser speech
        log.warning("speech prefetch failed: %s", exc)
