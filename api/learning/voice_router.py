"""Voice for the tutor: push-to-talk transcription in, Kokoro narration out.

Transcription proxies Muse Voice Transcribe so the key stays server-side; keyword hints come from the
session's own board and tutor history, never from the request. Speech serves the existing Kokoro engine
(Moonshine Voice, ONNX on CPU) behind the same identity cookie, so the web needs no public API base.
"""
from __future__ import annotations

import asyncio
import collections
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
from .router import call_store, private_response, require_owner
from .tutor_router import get_tutor_store

router = APIRouter(prefix="/learning", tags=["voice"], dependencies=[Depends(private_response)])
log = logging.getLogger("y.voice")
HOURLY_TRANSCRIPTIONS = 120
STATUS = {"transcribe_not_configured": 503, "transcribe_auth_failed": 502, "transcribe_rate_limited": 429,
          "transcribe_timeout": 504, "transcribe_failed": 502, "no_speech": 422, "audio_invalid": 415,
          "audio_too_large": 413, "audio_too_long": 413}
_provider_slots = asyncio.Semaphore(4)
_speech_slots = asyncio.Semaphore(2)
_recent: dict[str, collections.deque] = collections.defaultdict(collections.deque)


async def get_transcriber(request: Request):
    client = getattr(request.app.state, "board_http", None)
    if client is not None:
        yield MuseTranscriber(client)
    else:
        async with httpx.AsyncClient() as client:
            yield MuseTranscriber(client)


def _admit(owner: str) -> None:
    """In-process hourly window per owner; a paid call is never made past it."""
    now, window = time.monotonic(), _recent[owner]
    while window and now - window[0] > 3600:
        window.popleft()
    if len(window) >= HOURLY_TRANSCRIPTIONS:
        raise HTTPException(429, "transcribe_budget_exhausted")
    window.append(now)


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
                     turns=Depends(get_tutor_store), transcriber=Depends(get_transcriber)):
    started = time.perf_counter()
    if not transcriber.configured:
        raise HTTPException(503, "transcribe_not_configured")
    audio = await _read_wav(request)
    # Loading the board also checks that the session belongs to this owner, before any paid call.
    board = await call_store(boards.load, owner, sid)
    history = await call_store(turns.history, owner, str(sid))
    keywords = board_terms(board, history)
    _admit(owner)
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
async def speech(body: SpeechInput, owner=Depends(require_owner)):
    engine = get_speech_engine()
    if not engine.available:
        raise HTTPException(503, "speech_unavailable")
    try:
        async with _speech_slots:
            audio, metadata = await engine.synthesize(body.text, body.voice, body.speed)
    except SpeechError as exc:
        raise HTTPException(503 if not engine.available else 422, "speech_failed") from exc
    return Response(content=audio, media_type="audio/wav", headers={
        "X-Speech-Voice": str(metadata.get("voice", body.voice)),
        "X-Speech-Cache": "hit" if metadata.get("cached") else "miss",
        "Cache-Control": "no-store"})


async def prefetch_speech() -> None:
    """Load Kokoro voices at startup when SPEECH_PREFETCH=1 so the first narration is not cold."""
    if os.environ.get("SPEECH_PREFETCH") != "1":
        return
    try:
        await get_speech_engine().prefetch()
    except Exception as exc:  # optional: narration falls back to browser speech
        log.warning("speech prefetch failed: %s", exc)
