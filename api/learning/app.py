"""CPU-only entrypoint for the capture and tutor slices; no Ollama or Torch. Kokoro warms only with SPEECH_PREFETCH=1.

Local: uvicorn learning.app:app --env-file ../.env --port 8101
The existing main.app also mounts the same router.
"""
import asyncio
import hmac
import json
import os
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
    # Narration has its own pool: a turn's clauses fire together and must never starve the tutor stream.
    limits = httpx.Limits(max_connections=32, max_keepalive_connections=8, keepalive_expiry=60)
    async with httpx.AsyncClient(limits=limits) as client, httpx.AsyncClient(limits=limits) as speech_client:
        app.state.board_http = client
        app.state.speech_http = speech_client
        warm = asyncio.create_task(prefetch_speech())
        yield
        warm.cancel()

class ProxyOnly:
    """With LEARNING_PROXY_SECRET set (production), only the same-origin web proxy may call the API; /health stays
    open. Plain ASGI rather than BaseHTTPMiddleware, so streamed turns and client cancellation pass through untouched."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        secret = os.environ.get("LEARNING_PROXY_SECRET", "").encode()
        if scope["type"] == "http" and secret and scope["path"] != "/health":
            sent = dict(scope["headers"]).get(b"x-y-proxy-secret", b"")
            if not hmac.compare_digest(sent, secret):
                body = json.dumps({"detail": "proxy_required"}).encode()
                await send({"type": "http.response.start", "status": 403,
                            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


app = FastAPI(title="Y learning capture", version="0.2.0", lifespan=lifespan)
app.add_middleware(ProxyOnly)
app.include_router(router)
app.include_router(board_router)
app.include_router(tutor_router)
app.include_router(persona_router)
app.include_router(voice_router)


@app.get("/health")
def health():
    return {"status": "ok", "capability": "capture", "profile_updates": False}
