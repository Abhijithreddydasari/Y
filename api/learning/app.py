"""CPU-only entrypoint for the capture slice; no Ollama, Torch or speech warmup.

Local: uvicorn learning.app:app --env-file ../.env --port 8101
The existing main.app also mounts the same router.
"""
from fastapi import FastAPI

from .router import router

app = FastAPI(title="Y learning capture", version="0.1.0")
app.include_router(router)


@app.get("/health")
def health():
    return {"status": "ok", "capability": "capture", "profile_updates": False}
