"""FastAPI entry point for the AI Learning Companion backend.

Phase 0 endpoints:
- GET /health             liveness + ollama reachability
- POST /lesson            multipart PNG -> SSE stream of token/primitive events
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from teacher import OllamaTeacher, TeacherError
from parser import IncrementalTagParser
from validator import validate_and_repair

API_ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = API_ROOT.parent / "schema" / "primitives.json"

app = FastAPI(title="Y API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_teacher: OllamaTeacher | None = None


def get_teacher() -> OllamaTeacher:
    global _teacher
    if _teacher is None:
        _teacher = OllamaTeacher(
            host=os.environ.get("OLLAMA_HOST", "http://localhost:11434"),
            model=os.environ.get("MODEL_NAME", "gemma4:e4b"),
        )
    return _teacher


@app.on_event("startup")
async def _warmup() -> None:
    """Pre-warm Ollama with a tiny prompt so the first real request is fast."""
    try:
        get_teacher().warmup()
    except Exception as exc:
        print(f"[warmup] non-fatal: {exc}")


@app.get("/health")
async def health() -> dict:
    teacher = get_teacher()
    return {
        "status": "ok",
        "ollama_host": teacher.host,
        "model": teacher.model,
        "ollama_reachable": teacher.ping(),
        "schema_exists": SCHEMA_PATH.exists(),
    }


@app.get("/schema")
async def schema() -> dict:
    """Expose the primitive schema so the frontend can validate against the same source of truth."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@app.post("/lesson")
async def lesson(image: UploadFile = File(...)):
    """Accept a canvas PNG and stream lesson events.

    Returns SSE with two event types:
      - "token":     {"text": "..."}                free narrative tokens (for TTS)
      - "primitive": {"tag": "box", "args": {...}}  parsed and validated tag
      - "done":      {"reason": "..."}              terminal event
      - "error":     {"message": "..."}             terminal error
    """
    png_bytes = await image.read()
    teacher = get_teacher()
    parser = IncrementalTagParser()

    async def event_stream():
        try:
            async for token in teacher.stream_lesson(png_bytes):
                for evt in parser.feed(token):
                    if evt["event"] == "token":
                        yield {"event": "token", "data": json.dumps({"text": evt["text"]})}
                    elif evt["event"] == "primitive":
                        ok, fixed_tag = validate_and_repair(evt["tag"])
                        if ok:
                            yield {"event": "primitive", "data": json.dumps(fixed_tag)}
                        else:
                            yield {
                                "event": "token",
                                "data": json.dumps(
                                    {"text": fixed_tag.get("args", {}).get("content", "")}
                                ),
                            }
            for evt in parser.flush():
                if evt["event"] == "token":
                    yield {"event": "token", "data": json.dumps({"text": evt["text"]})}
                elif evt["event"] == "primitive":
                    ok, fixed_tag = validate_and_repair(evt["tag"])
                    if ok:
                        yield {"event": "primitive", "data": json.dumps(fixed_tag)}
            yield {"event": "done", "data": json.dumps({"reason": "completed"})}
        except TeacherError as exc:
            yield {"event": "error", "data": json.dumps({"message": str(exc)})}
        except Exception as exc:
            yield {"event": "error", "data": json.dumps({"message": f"internal: {exc}"})}

    return EventSourceResponse(event_stream())
