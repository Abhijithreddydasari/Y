"""Authenticated tutor turns: a question or an answer in, streamed board moves out."""
from __future__ import annotations

import json
import logging
import time
from uuid import UUID

import anyio
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import run_in_threadpool

from .board_contracts import ContextPacket
from .board_router import get_board_store
from .contracts import canonical, digest
from .router import call_store, get_store, private_response, require_owner
from .tutor_moves import TurnValidator
from .tutor_provider import MetaTutor
from .tutor_storage import TutorStore, open_question
from .tutor_turn import (TurnInput, TurnRun, board_focus, build_messages, grade, public_move, public_question,
                         question_of, session_memory, summary, this_turn)

router = APIRouter(prefix="/learning", tags=["tutor"], dependencies=[Depends(private_response)])
log = logging.getLogger("y.tutor")
TURN_SECONDS = 60
MESSAGES = {
    "provider_not_configured": "The tutor is not configured on the server (MODEL_API_KEY is missing). Your question and board are kept.",
    "provider_auth_failed": "The tutor's API key was rejected. Your question and board are kept.",
    "provider_rate_limited": "The tutor is busy right now. Wait a moment and ask again; your board is kept.",
    "provider_timeout": "The tutor took too long to answer. Your question and board are kept; ask again.",
    "turn_malformed": "The explanation stopped early. What was drawn is kept; ask again to continue.",
    "provider_output_truncated": "The explanation was cut short. What was drawn is kept; ask again to continue.",
}
FALLBACK = "The tutor is unavailable right now. Your question and board are kept; ask again."


def get_tutor_store(store=Depends(get_store)):
    return TutorStore(store)


async def get_tutor(request: Request):
    client = getattr(request.app.state, "board_http", None)
    if client is not None:
        yield MetaTutor(client)
    else:
        async with httpx.AsyncClient(limits=httpx.Limits(max_connections=8, max_keepalive_connections=4)) as client:
            yield MetaTutor(client)


def _event(name: str, value: dict) -> dict:
    return {"event": name, "data": json.dumps(value, ensure_ascii=False)}


def _replay(turn: dict):
    question = turn["question"]
    for index, move in enumerate(turn["moves"]):
        qid = question["qid"] if question and question["qid"].endswith(f".{index}") else None
        yield _event("move", {"index": index, "move": public_move(move, qid)})
    yield _event("done", {"status": turn["status"], "question": public_question(question) if question else None, "replayed": True})


@router.get("/sessions/{sid}/tutor")
async def state(sid: UUID, owner=Depends(require_owner), store=Depends(get_tutor_store), tutor=Depends(get_tutor)):
    history = await call_store(store.history, owner, str(sid))
    question = open_question(history)
    return {"configured": tutor.configured, "model": tutor.model, "open": public_question(question) if question else None,
            "turns": [{"turn_id": t["turn_id"], "seq": t["seq"], "kind": t["kind"], "status": t["status"],
                       "learner": t["input"].get("text") or t["input"].get("choice") or "",
                       "goals": [m["goal"] for m in t["moves"] if m["type"] == "seg"],
                       "said": [m["text"] for m in t["moves"] if m["type"] == "say"]} for t in history[-20:]]}


@router.post("/sessions/{sid}/tutor/turns")
async def turn(sid: UUID, body: TurnInput, owner=Depends(require_owner), store=Depends(get_tutor_store),
               boards=Depends(get_board_store), tutor=Depends(get_tutor)):
    started = time.perf_counter()
    if not tutor.configured:
        raise HTTPException(503, "tutor_not_configured")
    history = await call_store(store.history, owner, str(sid))
    question = open_question(history)
    if body.kind == "answer" and (question is None or question["qid"] != body.question_id):
        raise HTTPException(409, "tutor_question_not_open")
    value = body.model_dump(mode="json", exclude={"board"})
    replay = await call_store(store.begin, owner, str(sid), str(body.turn_id), body.kind, value, digest(canonical(body)))
    if replay is not None:
        return EventSourceResponse(_replay(replay), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    outcome = grade(question, body) if body.kind == "answer" else None
    run = None
    try:
        packet, images = None, []
        if body.board is not None:
            packet = ContextPacket.model_validate(await call_store(boards.capture_context, owner, sid, body.board))
            for crop in packet.crops:
                if crop.purpose == "initial" and len(images) < 2:
                    asset = await call_store(boards.get_asset, owner, sid, crop.asset_hash)
                    images.append((asset["mime"], asset["content"]))
        await call_store(store.reserve, owner)
        messages = build_messages("", session_memory(history), board_focus(packet), this_turn(body, question, outcome), images)
        run = TurnRun(tutor, messages, TurnValidator(frozenset(), len(images)),
                      reserve=lambda: call_store(store.reserve, owner), started=started)
        run.timing["context_ms"] = (time.perf_counter() - started) * 1000
    except BaseException:
        await run_in_threadpool(store.finish, str(body.turn_id), "failed", [], None, outcome, {"error": "context_or_budget"})
        raise

    async def events():
        yield _event("turn", {"turn_id": str(body.turn_id), "kind": body.kind, "outcome": outcome and {
            k: outcome[k] for k in ("qid", "result")}})
        try:
            with anyio.fail_after(TURN_SECONDS):
                async for index, move in run.events():
                    qid = f"{body.turn_id}.{index}" if index == run.question_index else None
                    yield _event("move", {"index": index, "move": public_move(move, qid)})
        except TimeoutError:
            run.error = "provider_timeout"
            run.status = run.final_status()
        except BaseException:
            # Client disconnect (Stop) cancels here; completed moves stay recorded.
            run.status = "waiting" if run.question_index is not None else "stopped"
            raise
        finally:
            run.timing["total_ms"] = (time.perf_counter() - started) * 1000
            question_value = question_of(run, str(body.turn_id))
            with anyio.CancelScope(shield=True):
                await run_in_threadpool(store.finish, str(body.turn_id), run.status, run.moves, question_value, outcome,
                                        {**summary(run), "provider": tutor.timing, "usage": tutor.usage})
            log.info("tutor turn=%s kind=%s status=%s moves=%s dropped=%s repairs=%s timing=%s usage=%s",
                     body.turn_id, body.kind, run.status, len(run.moves), len(run.dropped), run.repairs,
                     {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()}, tutor.usage)
        question_value = question_of(run, str(body.turn_id))
        if run.error and run.status in ("failed", "incomplete"):
            yield _event("error", {"code": run.error, "message": MESSAGES.get(run.error, FALLBACK), "status": run.status})
        yield _event("done", {"status": run.status, "question": public_question(question_value) if question_value else None,
                              "timing": {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()},
                              "moves": len(run.moves), "dropped": len(run.dropped), "repairs": run.repairs, "usage": tutor.usage})
    return EventSourceResponse(events(), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
