"""Authenticated board capture, perception, provisional assessment and teaching."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sse_starlette.sse import EventSourceResponse

from .assessment import assess_capture
from .board_contracts import ContextInput, ContextPacket, Correction, EditBatch, RegionInput, TeachInput
from .board_context import MAX_CONTEXT, build_context, model_context
from .board_reader import MetaBoardReader, interpret
from .board_storage import BoardStore
from .contracts import AttemptInput, CapturedAttempt, SourceRef, canonical, digest, now_iso
from .decisions import ProviderFailure
from .packs import TASKS
from .router import call_store, get_provider, get_store, private_response, require_owner
from .storage import StoreError

router = APIRouter(prefix="/learning", tags=["board"], dependencies=[Depends(private_response)])
log = logging.getLogger("y.board")


def get_board_store(store=Depends(get_store)):
    return BoardStore(store)


async def get_reader(request: Request):
    client = getattr(request.app.state, "board_http", None)
    if client is not None:
        yield MetaBoardReader(client)
    else:
        async with httpx.AsyncClient(limits=httpx.Limits(max_connections=8, max_keepalive_connections=4)) as client:
            yield MetaBoardReader(client)


@router.get("/sessions/{sid}/board")
async def load(sid: UUID, revision: int | None = Query(None, ge=0), owner=Depends(require_owner), store=Depends(get_board_store)):
    return await call_store(store.load, owner, sid, revision)


@router.post("/sessions/{sid}/board/edits")
async def edit(sid: UUID, body: EditBatch, owner=Depends(require_owner), store=Depends(get_board_store)):
    return await call_store(store.apply, owner, sid, body)


@router.post("/sessions/{sid}/board/assets")
async def upload(sid: UUID, request: Request, owner=Depends(require_owner), store=Depends(get_board_store)):
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 2 * 1024 * 1024:
            raise HTTPException(413, "board_asset_size_limit")
    return await call_store(store.put_asset, owner, sid, bytes(data))


@router.get("/sessions/{sid}/board/assets/{key}")
async def asset(sid: UUID, key: str, owner=Depends(require_owner), store=Depends(get_board_store)):
    value = await call_store(store.get_asset, owner, sid, key)
    return Response(value["content"], media_type=value["mime"], headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/sessions/{sid}/board/regions")
async def region(sid: UUID, body: RegionInput, owner=Depends(require_owner), store=Depends(get_board_store)):
    return await call_store(store.region, owner, sid, body)


@router.post("/sessions/{sid}/board/attempts")
async def capture(sid: UUID, body: ContextInput, owner=Depends(require_owner), store=Depends(get_board_store)):
    await call_store(store.capture_context, owner, sid, body)
    return await call_store(store.attempt, owner, body.request_id)


@router.post("/sessions/{sid}/board/context")
async def preview(sid: UUID, body: ContextInput, owner=Depends(require_owner), store=Depends(get_board_store)):
    board = await call_store(store.load, owner, sid, body.revision)
    return build_context(sid, body.revision, board["records"], board["regions"], body).model_dump(mode="json")


@router.get("/board-attempts/{aid}")
async def get_attempt(aid: UUID, owner=Depends(require_owner), store=Depends(get_board_store)):
    return await call_store(store.attempt, owner, aid)


@router.get("/sessions/{sid}/board/attempts")
async def list_attempts(sid: UUID, owner=Depends(require_owner), store=Depends(get_board_store)):
    return await call_store(store.list_attempts, owner, sid)


@router.post("/board-attempts/{aid}/corrections")
async def correct(aid: UUID, body: Correction, owner=Depends(require_owner), store=Depends(get_board_store)):
    return await call_store(store.correct, owner, aid, body)


def evidence_text(packet, reading):
    texts = []
    for f in packet.focused:
        if f["creator"] != "human" or f["mixed"]:
            continue
        text = f["text"] or (f.get("semantic") or {}).get("latex", "")
        if text:
            texts.append(text)
    eligible = {f["id"] for f in packet.focused if f["creator"] == "human" and not f["mixed"]}
    for item in reading["items"]:
        if item["status"] == "readable" and set(item["element_ids"]) <= eligible:
            texts.append(item["text"])
    return "\n".join(texts)


@router.post("/board-attempts/{aid}/assess")
async def assess(aid: UUID, owner=Depends(require_owner), store=Depends(get_board_store), reader=Depends(get_reader), provider=Depends(get_provider)):
    value = await call_store(store.attempt, owner, aid)
    token = await call_store(store.claim_attempt, owner, aid)
    if token is None:
        return value
    packet = ContextPacket.model_validate(value["packet"])
    started = time.perf_counter()
    result = {"profile_updated": False, "board_source": packet.source.model_dump(mode="json"), "observations": [], "interpretation": None, "provider_error": None}
    try:
        async with asyncio.timeout(30):
            if not packet.coverage["complete"]:
                result["status"] = "incomplete"
            else:
                reading = await interpret(store, owner, packet, reader)
                result["interpretation"] = reading
                task = TASKS.get(packet.task_id)
                text = evidence_text(packet, reading)
                if reading.get("uncertain") or reading["unresolved"]:
                    result["status"] = "needs_clarification" if reading["unresolved"] else "pending_review"
                elif task is None or not text.strip():
                    result["status"] = "insufficient_learner_evidence"
                elif len(text) > 8000:
                    result["status"] = "incomplete"
                else:
                    source = SourceRef(event_id=uuid4(), content_hash=digest(text), start=0, end=len(text))
                    derived = CapturedAttempt(owner_id=owner, session_id=packet.source.session_id, task=task,
                        attempt=AttemptInput(attempt_id=aid, task_id=task.task_id, text=text, assistance=packet.assistance), source=source, captured_at=now_iso())
                    if provider.api_key:
                        await call_store(store.reserve, owner, "decision")
                    assessment = await assess_capture(derived, provider)
                    result["provider_error"] = assessment.provider_error
                    result["observations"] = [{**o.model_dump(mode="json"), "source": packet.source.model_dump(mode="json"),
                        "status": "pending_review" if o.status == "accepted" and (reading["items"] or not packet.assistance.independent) else o.status}
                        for o in assessment.observations]
                    result["status"] = "pending_review" if reading["items"] else "assessed"
                    result["usage"] = assessment.usage
    except (ProviderFailure, TimeoutError) as exc:
        result["provider_error"] = exc.code if isinstance(exc, ProviderFailure) else "provider_timeout"
        result["status"] = "unavailable"
    except (HTTPException, StoreError):
        result["provider_error"], result["status"] = "provider_budget_or_concurrency", "unavailable"
    result["latency_ms"] = (time.perf_counter() - started) * 1000
    await call_store(store.finish, aid, token, result)
    return await call_store(store.attempt, owner, aid)


def get_board_teacher(body: TeachInput):
    from teacher import resolve_teacher
    return resolve_teacher(body.model_choice)


@router.post("/sessions/{sid}/board/teach")
async def teach(sid: UUID, body: TeachInput, owner=Depends(require_owner), store=Depends(get_board_store), reader=Depends(get_reader)):
    # Save the frozen source before returning a streaming response.
    capture_body = ContextInput.model_validate(body.model_dump(exclude={"model_choice"}))
    packet = ContextPacket.model_validate(await call_store(store.capture_context, owner, sid, capture_body))
    teacher = get_board_teacher(body)

    async def events():
        from parser import IncrementalTagParser
        from teacher import stream_board_context
        from validator import validate_and_repair
        parser = IncrementalTagParser()
        started, count, chars = time.perf_counter(), 0, 0
        stream = None
        try:
            async with asyncio.timeout(120):
                yield {"event": "status", "data": json.dumps({"text": "Reading relevant board content…"})}
                if not packet.coverage["complete"]:
                    yield {"event": "error", "data": json.dumps({"message": "The focused area is incomplete or too large. Your board is saved; focus a smaller area."})}
                    return
                reading = await interpret(store, owner, packet, reader)
                yield {"event": "interpretation", "data": json.dumps(reading)}
                if reading["unresolved"]:
                    yield {"event": "error", "data": json.dumps({"message": "A detail needed to understand the problem is unreadable. Please clarify that part."})}
                    return
                await call_store(store.reserve, owner, "teach")
                images = []
                for crop in packet.crops:
                    if crop.purpose == "initial":
                        a = await call_store(store.get_asset, owner, sid, crop.asset_hash)
                        images.append(a["content"])
                prompt = canonical({"board": model_context(packet), "interpretation": {"items": reading["items"], "unresolved": reading["unresolved"]}})
                if len(prompt.encode("utf-8")) > MAX_CONTEXT:
                    yield {"event": "error", "data": json.dumps({"message": "This area needs more context than fits reliably. Your work is saved; focus a smaller part."})}
                    return
                yield {"event": "context", "data": canonical({"source": packet.source.model_dump(mode="json"), "response_area": packet.response_area.model_dump()})}
                stream = stream_board_context(teacher, prompt, images, digest(owner))
                while True:
                    try:
                        token = await asyncio.wait_for(anext(stream), timeout=25)
                    except StopAsyncIteration:
                        break
                    chars += len(token)
                    if chars > 60_000:
                        raise ValueError("teacher output limit")
                    for event in parser.feed(token):
                        if event["event"] == "primitive":
                            tag = event["tag"]
                            if tag.get("tag") not in {"title", "text", "equation", "box", "node", "arrow", "line", "draw", "draw_part"}:
                                continue
                            if len(canonical(tag).encode("utf-8")) > 32_000:
                                raise ValueError("primitive size limit")
                            ok, tag = validate_and_repair(tag)
                            if not ok:
                                continue
                            # Keep layout in our response zone; models don't get arbitrary global coordinates.
                            tag["args"] = {k: v for k, v in tag["args"].items() if k not in {"x", "y"}}
                            for key in ("x1", "y1", "x2", "y2"):
                                if key in tag["args"]:
                                    tag["args"][key] = min(620, max(0, float(tag["args"][key])))
                            for key in ("w", "h", "width", "height", "r"):
                                if key in tag["args"]:
                                    try:
                                        tag["args"][key] = min(620, max(1, float(tag["args"][key])))
                                    except (ValueError, TypeError):
                                        tag["args"].pop(key)
                            count += 1
                            if count > 60:
                                raise ValueError("primitive limit")
                            yield {"event": "primitive", "data": json.dumps(tag)}
                yield {"event": "generation_complete", "data": "{}"}
                yield {"event": "done", "data": "{}"}
        except Exception:
            yield {"event": "error", "data": json.dumps({"message": "Teaching is unavailable. Your board and source are saved."})}
        finally:
            if stream is not None:
                await stream.aclose()
            log.info("board teach attempt=%s elapsed_ms=%.1f primitives=%s", body.request_id, (time.perf_counter() - started) * 1000, count)
    return EventSourceResponse(events(), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
