"""FastAPI entry point for the AI Learning Companion backend.

Endpoints:
- GET /health             liveness + ollama reachability
- GET /schema             expose primitives.json so the frontend can validate
- POST /lesson            multipart PNG -> SSE stream of token/primitive events
- GET /learner/{user_id}  return the per-user knowledge profile
"""
from __future__ import annotations

import json
import os
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = API_ROOT.parent / "schema" / "primitives.json"


def _load_env_file() -> None:
    """Tiny zero-dep .env loader so judges only need to fill `.env` and run.

    Looks for `<repo-root>/.env` first, then `<api>/.env`. Skips lines that
    are blank, comments, or already exported in the process environment so
    explicit shell `set FOO=bar` overrides take precedence.
    """
    candidates = [API_ROOT.parent / ".env", API_ROOT / ".env"]
    for path in candidates:
        if not path.exists():
            continue
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, _, v = s.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        except OSError:
            pass


_load_env_file()

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from sse_starlette.sse import EventSourceResponse  # noqa: E402

from learner import LearnerStore  # noqa: E402
from teacher import (  # noqa: E402
    MODEL_REGISTRY,
    OllamaTeacher,
    Teacher,
    TeacherError,
    resolve_teacher,
)
from parser import IncrementalTagParser  # noqa: E402
from salvage import salvage_raw_to_primitives  # noqa: E402
from validator import validate_and_repair  # noqa: E402

app = FastAPI(title="Y API", version="0.1.0")

_cors_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
_extra_cors = os.environ.get("CORS_ORIGINS", "").strip()
if _extra_cors:
    _cors_origins.extend(o.strip() for o in _extra_cors.split(",") if o.strip())

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_learner_store: LearnerStore | None = None


def get_teacher(model_choice: str = "edge") -> Teacher:
    """Return the cached Teacher matching the toolbar's `model_choice`.

    Defaults to the edge baseline so /health and warmup never need to know
    about the user's selection.
    """
    return resolve_teacher(model_choice)


def get_learner_store() -> LearnerStore:
    global _learner_store
    if _learner_store is None:
        _learner_store = LearnerStore()
    return _learner_store


@app.on_event("startup")
async def _warmup() -> None:
    """Pre-warm the default (edge) teacher so the first real request is fast."""
    try:
        get_teacher("edge").warmup()
    except Exception as exc:
        print(f"[warmup] non-fatal: {exc}")


@app.get("/health")
async def health() -> dict:
    """Liveness + per-model readiness for the toolbar.

    The Ollama daemon is socket-pinged with a 1s timeout. Each ping runs in
    a worker thread via ``asyncio.to_thread`` so the registry's three
    readiness probes don't serialise on /health.
    """
    import asyncio as _asyncio

    edge = get_teacher("edge")
    is_ollama = isinstance(edge, OllamaTeacher)

    async def _ready(choice: str) -> bool:
        try:
            t = get_teacher(choice)
            return bool(await _asyncio.to_thread(t.ping))
        except Exception:
            return False

    choices = list(MODEL_REGISTRY.keys())
    flags = await _asyncio.gather(*(_ready(c) for c in choices))
    ready_by_choice = dict(zip(choices, flags))
    edge_ready = ready_by_choice.get("edge", False) if is_ollama else False

    return {
        "status": "ok",
        "ollama_host": edge.host if is_ollama else "",
        "model": edge.model,
        "ollama_reachable": edge_ready,
        "schema_exists": SCHEMA_PATH.exists(),
        "models": {
            choice: {
                "kind": cfg["kind"],
                "model": cfg["model"],
                "ready": ready_by_choice.get(choice, False),
            }
            for choice, cfg in MODEL_REGISTRY.items()
        },
    }


@app.get("/schema")
async def schema() -> dict:
    """Expose the primitive schema so the frontend can validate against the same source of truth."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@app.post("/lesson")
async def lesson(
    image: UploadFile = File(...),
    teacher_mode: bool = Form(False),
    user_id: str = Form("anon"),
    model_choice: str = Form("edge"),
):
    """Accept a canvas PNG and stream lesson events.

    Form fields:
      - image          (required, PNG): the canvas snapshot
      - teacher_mode   (bool, default False): if true, fire a second Gemma call
                       after the lesson stream completes, asking for educator
                       JSON (misconceptions / follow_ups / prereqs / difficulty)
                       streamed as a single `educator_notes` event.
      - user_id        (str, default 'anon'): stable per-browser identifier
                       used by the learner module to track mastery across
                       sessions.
      - model_choice   (str, default 'edge'): one of 'edge' (gemma4:e4b),
                       'edge-ft' (the fine-tuned y-gemma4 LoRA-merged GGUF),
                       or 'cloud' (Gemma-4-31B via Google AI Studio). Honoured
                       even if the chosen backend isn't running -- the call
                       will surface a clear error event in that case.

    SSE event types:
      - "token":           {"text": "..."}                free narrative tokens
      - "primitive":       {"tag": "box", "args": {...}}  validated tag
      - "educator_notes":  {misconceptions, follow_ups, prereqs, difficulty}
      - "learner_update":  {topic, concepts_seen, mastered, struggling, ...}
      - "done":            {"reason": "..."}              terminal event
      - "error":           {"message": "..."}             terminal error
    """
    png_bytes = await image.read()
    teacher = get_teacher(model_choice)
    learner = get_learner_store()
    parser = IncrementalTagParser()
    primitives_count = 0
    # Pull the learner's mastery prefix (if any) and prepend it to the
    # system prompt for THIS lesson only. The teacher object's base prompt
    # is left untouched so concurrent calls don't bleed into each other.
    mastery_prefix = learner.system_prompt_prefix(user_id)

    async def event_stream():
        # Accumulate the parsed lesson text so the educator-notes + learner
        # calls can condition on what the tutor actually said.
        nonlocal primitives_count
        lesson_chunks: list[str] = []
        try:
            async for token in teacher.stream_lesson(png_bytes, system_prefix=mastery_prefix):
                lesson_chunks.append(token)
                for evt in parser.feed(token):
                    if evt["event"] == "token":
                        yield {"event": "token", "data": json.dumps({"text": evt["text"]})}
                    elif evt["event"] == "primitive":
                        ok, fixed_tag = validate_and_repair(evt["tag"])
                        if ok:
                            primitives_count += 1
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
                        primitives_count += 1
                        yield {"event": "primitive", "data": json.dumps(fixed_tag)}

            # Last-resort salvage: if the parser produced 0 primitives the
            # model ignored the tag protocol entirely (common with the small
            # gemma4:e4b baseline). Synthesise primitives from the raw text
            # so the whiteboard still draws something.
            if primitives_count == 0 and lesson_chunks:
                raw_text = "".join(lesson_chunks)
                for synth in salvage_raw_to_primitives(raw_text):
                    primitives_count += 1
                    yield {"event": "primitive", "data": json.dumps(synth)}

            if teacher_mode:
                try:
                    notes = await teacher.educator_notes(
                        png_bytes, lesson_text="".join(lesson_chunks)
                    )
                    yield {"event": "educator_notes", "data": json.dumps(notes)}
                except Exception as exc:
                    # Educator notes are advisory; never fail the lesson over them.
                    yield {
                        "event": "educator_notes",
                        "data": json.dumps({
                            "misconceptions": [], "follow_ups": [],
                            "prereqs": [], "difficulty": "",
                            "error": f"educator notes failed: {exc}",
                        }),
                    }

            # Update the learner profile after the lesson completes. This is
            # advisory and runs inline (not background) so the SSE stream
            # surfaces the new session record before "done", letting the
            # learner panel light up immediately.
            #
            # The extractor model is ALWAYS the local edge model: when the
            # active teacher is cloud, we still want the learner panel to
            # update with a fast/free local extraction (no extra API spend
            # per session).
            extractor_model = get_teacher("edge").model
            try:
                rec = await learner.update(
                    user_id=user_id,
                    lesson_text="".join(lesson_chunks),
                    primitives_count=primitives_count,
                    teacher_model=extractor_model,
                )
                # Don't push the (large) raw embedding through SSE; the panel
                # fetches the full profile via /learner/{user_id} for UMAP.
                payload = {k: v for k, v in rec.__dict__.items() if k != "embedding"}
                payload["has_embedding"] = bool(rec.embedding)
                yield {"event": "learner_update", "data": json.dumps(payload)}
            except Exception as exc:
                yield {
                    "event": "learner_update",
                    "data": json.dumps({"error": f"learner update failed: {exc}"}),
                }

            yield {"event": "done", "data": json.dumps({"reason": "completed"})}
        except TeacherError as exc:
            yield {"event": "error", "data": json.dumps({"message": str(exc)})}
        except Exception as exc:
            yield {"event": "error", "data": json.dumps({"message": f"internal: {exc}"})}

    return EventSourceResponse(event_stream())


@app.get("/learner/{user_id}")
async def learner_profile(user_id: str) -> dict:
    """Return the per-user knowledge profile.

    Includes every session (with its embedding) so the frontend can run UMAP
    client-side. Empty profile for first-time visitors.
    """
    store = get_learner_store()
    profile = store.get(user_id)
    return {
        "user_id": profile.user_id,
        "sessions": profile.sessions,
        "mastery_summary": profile.mastery_summary(),
    }


@app.delete("/learner/{user_id}")
async def reset_learner(user_id: str) -> dict:
    """Wipe a learner profile (useful during demo recording).

    Returns 200 even if the file didn't exist.
    """
    store = get_learner_store()
    p = store._path(user_id)  # noqa: SLF001 - intentional internal access
    try:
        p.unlink(missing_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    # Drop the in-memory cache so the next get() returns a fresh profile.
    store._cache.pop(user_id, None)  # noqa: SLF001
    return {"ok": True}
