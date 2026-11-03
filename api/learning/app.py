"""CPU-only entrypoint for the capture and tutor slices; no Ollama or Torch. Kokoro warms only with SPEECH_PREFETCH=1.

Local: uvicorn learning.app:app --env-file ../.env --port 8101
The existing main.app also mounts the same router.
"""
import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from .router import router
from .board_router import router as board_router
from .persona_router import router as persona_router
from .tutor_router import router as tutor_router
from .voice_router import prefetch_speech, router as voice_router


@asynccontextmanager
async def lifespan(app):
    # Idle connections to the provider stay pooled for a minute, so a transcription warmed at record start is not cold.
    limits = httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=60)
    async with httpx.AsyncClient(limits=limits) as client:
        app.state.board_http = client
        warm = asyncio.create_task(prefetch_speech())
        yield
        warm.cancel()

app = FastAPI(title="Y learning capture", version="0.2.0", lifespan=lifespan)
app.include_router(router)
app.include_router(board_router)
app.include_router(tutor_router)
app.include_router(persona_router)
app.include_router(voice_router)


@app.get("/health")
def health():
    return {"status": "ok", "capability": "capture", "profile_updates": False}
