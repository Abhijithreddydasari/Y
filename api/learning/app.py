"""CPU-only entrypoint for the capture slice; no Ollama, Torch or speech warmup.

Local: uvicorn learning.app:app --env-file ../.env --port 8101
The existing main.app also mounts the same router.
"""
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from .router import router
from .board_router import router as board_router
from .tutor_router import router as tutor_router


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=8, max_keepalive_connections=4)) as client:
        app.state.board_http = client
        yield

app = FastAPI(title="Y learning capture", version="0.2.0", lifespan=lifespan)
app.include_router(router)
app.include_router(board_router)
app.include_router(tutor_router)


@app.get("/health")
def health():
    return {"status": "ok", "capability": "capture", "profile_updates": False}
