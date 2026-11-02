"""Authenticated tutor turns: a question or an answer in, streamed board moves out."""
from __future__ import annotations

import json
import logging
import time
from uuid import UUID

import anyio
import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import run_in_threadpool

from . import image_jobs, observations, profile
from .board_contracts import ContextPacket
from .board_router import get_board_store
from .consolidate import NOTES_MODEL, NotesWriter, evidence_payload, keep_cited
from .contracts import Contract, canonical, digest
from .decisions import ProviderFailure, evidence_labeler
from .learner_contracts import LearnerBrief
from .router import call_store, get_store, private_response, require_owner
from .storage import StoreError
from .tutor_models import OptionUnavailable, resolve, tutor_options, voice_options
from .tutor_moves import TurnValidator
from .tutor_provider import MetaTutor
from .tutor_storage import TutorStore, open_question
from .tutor_turn import (TurnInput, TurnRun, board_focus, build_messages, grade, public_move, public_question,
                         question_of, session_memory, summary, this_turn)

router = APIRouter(prefix="/learning", tags=["tutor"], dependencies=[Depends(private_response)])
log = logging.getLogger("y.tutor")
TURN_SECONDS = 60
CLOSE_LABEL_SECONDS = 20  # re-labeling at close waits at most this long
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


def get_image_jobs(store=Depends(get_store)):
    return image_jobs.ImageJobs(store)


def get_evidence(store=Depends(get_store)):
    return observations.ObservationStore(store)


def get_labeler():
    return evidence_labeler()


def get_profiles(store=Depends(get_store)):
    return profile.ProfileStore(store)


def get_notes_writer(request: Request):
    return NotesWriter(getattr(request.app.state, "board_http", None))


class MemoryInput(Contract):
    memory: bool


def session_brief(profiles, owner: str, sid: str, topic: str) -> tuple[LearnerBrief | None, bool]:
    """(brief for this turn, memory on). The session's first brief stands; Memory off reads nothing."""
    state = profiles.memory(owner, sid)
    if state["status"] != "open":
        raise StoreError(409, "session_closed")
    if not state["memory"]:
        return None, False
    if state["brief"]:
        return LearnerBrief.model_validate(state["brief"]), True
    revision, index = profiles.latest(owner)
    brief = profile.compile_brief(revision, index, topic)
    if brief is not None:
        profiles.keep_brief(sid, brief)
        brief = LearnerBrief.model_validate(profiles.memory(owner, sid)["brief"])
    return brief, True


def _human_ink(boards, owner: str, sid: UUID, element_ids: tuple[str, ...]) -> None:
    """Ink evidence must be the learner's own strokes; tutor-drawn or unknown elements never count."""
    records = boards.load(owner, sid)["records"]
    if any(records.get(i, {}).get("creator") != "human" for i in element_ids):
        raise HTTPException(422, "evidence_not_learner")


def ink_crops(body: TurnInput) -> tuple[str, ...]:
    """Crops that show only the answer's own ink (already checked human-authored); never tutor-drawn content."""
    if body.via != "ink" or body.board is None or not body.element_ids:
        return ()
    mine = set(body.element_ids)
    return tuple(c.asset_hash for c in body.board.crops if set(c.element_ids) <= mine)[:observations.MAX_CROPS]


async def record_evidence(evidence, labeler, owner: str, sid: str, body: TurnInput, question: dict, outcome: dict,
                          history: list[dict]) -> None:
    """Record the answer once and start labeling in the background. Never fails or delays the lesson."""
    try:
        row, created = await call_store(evidence.capture_answer, owner, sid, str(body.turn_id), question, outcome["answer"],
                                        outcome, observations.modality_of(body.via, body.choice), history, body.element_ids,
                                        ink_crops(body))
        if created and row["status"] == "pending":
            observations.start(evidence, labeler, owner, row["observation_id"])
    except Exception as exc:  # the trace shows the gap; the learner never does
        log.warning("evidence capture failed turn=%s (%s)", body.turn_id, type(exc).__name__)


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


@router.get("/tutor/options")
async def options(owner=Depends(require_owner)):
    """Models and voices the picker offers, each with availability and a reason when disabled."""
    from speech import get_speech_engine  # imported lazily: the voice engine is optional

    try:
        engine = get_speech_engine()
    except Exception:  # an engine that cannot even construct is simply unavailable
        engine = None
    return {"models": tutor_options(), "voices": voice_options(engine)}


@router.get("/sessions/{sid}/tutor")
async def state(sid: UUID, owner=Depends(require_owner), store=Depends(get_tutor_store), tutor=Depends(get_tutor)):
    history = await call_store(store.history, owner, str(sid))
    question = open_question(history)
    return {"configured": tutor.configured, "model": tutor.model, "open": public_question(question) if question else None,
            "turns": [{"turn_id": t["turn_id"], "seq": t["seq"], "kind": t["kind"], "status": t["status"],
                       "learner": t["input"].get("text") or t["input"].get("choice") or "",
                       "goals": [m["goal"] for m in t["moves"] if m["type"] == "seg"],
                       "said": [m["text"] for m in t["moves"] if m["type"] == "say"],
                       "tutor": (t["timing"] or {}).get("tutor")} for t in history[-20:]]}


@router.get("/sessions/{sid}/evidence")
async def evidence_trace(sid: UUID, owner=Depends(require_owner), evidence=Depends(get_evidence),
                         profiles=Depends(get_profiles)):
    """Developer trace of answered checks: verifier, labels and failures. Profiles are written at session close (H5)."""
    rows = await call_store(evidence.entries, owner, str(sid))
    sealed = await call_store(profiles.for_session, owner, str(sid))
    return {"observations": rows, "profile_updated": sealed is not None,
            "profile_revision": sealed["revision"].revision if sealed else None}


@router.get("/sessions/{sid}/memory")
async def memory_state(sid: UUID, owner=Depends(require_owner), profiles=Depends(get_profiles)):
    return await call_store(profiles.memory, owner, str(sid))


@router.put("/sessions/{sid}/memory")
async def set_memory(sid: UUID, body: MemoryInput, owner=Depends(require_owner), profiles=Depends(get_profiles)):
    """Memory off: turns read no brief (the with/without comparison). Evidence is still captured and sealed."""
    return await call_store(profiles.set_memory, owner, str(sid), body.memory)


@router.get("/profile")
async def learner_profile(q: str = "", owner=Depends(require_owner), profiles=Depends(get_profiles)):
    """The latest revision and the brief a question would get now (trace and Constellation input)."""
    revision, index = await call_store(profiles.latest, owner)
    brief = profile.compile_brief(revision, index, q[:200])
    return {"revision": revision.model_dump(mode="json") if revision else None,
            "brief": brief.model_dump(mode="json") if brief else None, "brief_text": profile.render_brief(brief)}


def _summary(revision, found, left, relabel, notes_trace, started) -> dict:
    touched = {(o.concept, o.dimension) for o in found}
    return {"session_id": str(revision.session_id), "revision": revision.revision, "sealed": len(found),
            "left_out": left, "relabel": relabel,
            "beliefs": [{"concept": b.concept, "dimension": b.dimension, "mean": round(b.mean, 3)}
                        for b in revision.beliefs if (b.concept, b.dimension) in touched],
            "misconceptions": [m.id for m in revision.misconceptions if m.status == "active"],
            "notes": [n.text for n in revision.notes], "notes_trace": notes_trace,
            "ms": round((time.perf_counter() - started) * 1000)}


@router.post("/sessions/{sid}/close")
async def close(sid: UUID, owner=Depends(require_owner), store=Depends(get_tutor_store), evidence=Depends(get_evidence),
                labeler=Depends(get_labeler), profiles=Depends(get_profiles), writer=Depends(get_notes_writer)):
    """Seal the session once: re-label what is open, reduce, add cited notes, write one revision. Replays change nothing."""
    started = time.perf_counter()
    state = await call_store(profiles.begin_close, owner, str(sid))
    if state == "closed":
        stored = await call_store(profiles.for_session, owner, str(sid))
        if stored is None:
            return {"session_id": str(sid), "revision": None, "sealed": 0, "profile_updated": False, "replayed": True}
        return {**stored["close"], "profile_updated": True, "replayed": True}
    try:
        ids = await call_store(evidence.requeue, owner, str(sid))
        relabel = {"requeued": len(ids)}
        with anyio.move_on_after(CLOSE_LABEL_SECONDS) as waited:
            async with anyio.create_task_group() as group:
                for observation_id in ids:
                    group.start_soon(observations.label, evidence, labeler, owner, observation_id)
            # Labels started by turns hold a lease; wait for them too.
            while any(r["status"] == "pending" for r in await call_store(evidence.entries, owner, str(sid))):
                await anyio.sleep(0.1)
        relabel["timed_out"] = waited.cancelled_caught
        found, left = await call_store(evidence.sealed, owner, str(sid))
        if not found:
            await call_store(profiles.finish_empty, str(sid))
            return {"session_id": str(sid), "revision": None, "sealed": 0, "left_out": left, "relabel": relabel,
                    "profile_updated": False, "replayed": False}
        texts = await call_store(evidence.misconception_texts, str(sid))
        previous, index = await call_store(profiles.latest, owner)
        draft, _ = profile.reduce(previous, index, found, str(sid), descriptions=texts)
        touched = {(o.concept, o.dimension) for o in found}
        beliefs = [{"concept": b.concept, "dimension": b.dimension, "mean": round(b.mean, 3)}
                   for b in draft.beliefs if (b.concept, b.dimension) in touched]
        notes, notes_trace = [], {}
        try:
            await call_store(store.reserve, owner)
            answers = await call_store(evidence.answers, str(sid))
            raw, notes_trace = await writer.write(evidence_payload(found, answers, beliefs))
            notes, notes_trace["dropped"] = keep_cited(raw, {str(o.observation_id) for o in found})
            notes_trace["kept"] = len(notes)
        except (ProviderFailure, HTTPException) as exc:  # the revision is written without notes
            notes_trace = {"error": getattr(exc, "code", None) or str(exc.detail)}
        except Exception as exc:
            notes_trace = {"error": "notes_failed"}
            log.warning("teaching notes failed session=%s (%s)", sid, type(exc).__name__)

        def build(prev, idx):
            revision, new_index = profile.reduce(prev, idx, found, str(sid), notes, NOTES_MODEL if notes else None,
                                                 descriptions=texts)
            return revision, new_index, _summary(revision, found, left, relabel, notes_trace, started)

        revision, summary, replayed = await call_store(profiles.write, owner, str(sid), build)
        log.info("session %s sealed revision=%s observations=%s notes=%s in %s ms", sid, revision.revision,
                 len(found), len(revision.notes), summary["ms"])
        return {**summary, "profile_updated": True, "replayed": replayed}
    except BaseException:
        with anyio.CancelScope(shield=True):
            await run_in_threadpool(profiles.abort_close, str(sid))
        raise


@router.get("/sessions/{sid}/images/{image_id}")
async def image(sid: UUID, image_id: str = Path(pattern=r"^[0-9a-f]{32}$"), owner=Depends(require_owner),
                images=Depends(get_image_jobs)):
    """Status of an illustration started by an `image` move; a ready one names its board asset."""
    return await call_store(images.get, owner, str(sid), image_id)


@router.post("/sessions/{sid}/tutor/turns")
async def turn(sid: UUID, body: TurnInput, request: Request, owner=Depends(require_owner), store=Depends(get_tutor_store),
               boards=Depends(get_board_store), tutor=Depends(get_tutor), illustrations=Depends(get_image_jobs),
               evidence=Depends(get_evidence), labeler=Depends(get_labeler), profiles=Depends(get_profiles)):
    started = time.perf_counter()
    try:
        option = resolve(body.model)
    except OptionUnavailable as exc:
        raise HTTPException(422, str(exc)) from None
    if body.model:
        tutor.use(option)
    if not tutor.configured:
        raise HTTPException(503, "tutor_not_configured")
    history = await call_store(store.history, owner, str(sid))
    topic = body.text if body.kind == "question" else next((t["input"].get("text", "") for t in history
                                                             if t["kind"] == "question"), "")
    brief, memory_on = await call_store(session_brief, profiles, owner, str(sid), topic)
    question = open_question(history)
    if body.kind == "answer" and (question is None or question["qid"] != body.question_id):
        raise HTTPException(409, "tutor_question_not_open")
    if body.element_ids:
        await call_store(_human_ink, boards, owner, sid, body.element_ids)
    value = body.model_dump(mode="json", exclude={"board"})
    replay = await call_store(store.begin, owner, str(sid), str(body.turn_id), body.kind, value, digest(canonical(body)))
    if replay is not None:
        return EventSourceResponse(_replay(replay), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    outcome = grade(question, body) if body.kind == "answer" else None
    if outcome is not None:
        await record_evidence(evidence, labeler, owner, str(sid), body, question, outcome, history)
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
        messages = build_messages(profile.render_brief(brief), session_memory(history), board_focus(packet),
                                  this_turn(body, question, outcome), images)
        run = TurnRun(tutor, messages, TurnValidator(brief.refs if brief else frozenset(), len(images)),
                      reserve=lambda: call_store(store.reserve, owner), started=started)
        run.timing["context_ms"] = (time.perf_counter() - started) * 1000
    except BaseException:
        await run_in_threadpool(store.finish, str(body.turn_id), "failed", [], None, outcome, {"error": "context_or_budget"})
        raise

    # What the learner model contributed to this turn (Memory on/off comparison, trace).
    memory_brief = {"on": memory_on, "revision": brief.profile_revision if brief else None,
                    "items": [{"id": i.id, "kind": i.kind, "text": i.text} for i in brief.items] if brief else []}

    async def illustrate(move: dict) -> None:
        # The stored move keeps the job id, so a replay shows the same image without a new paid call.
        job = await call_store(illustrations.create, owner, str(sid), str(body.turn_id), move["prompt"], move["alt"],
                               bool(image_jobs.api_key()))
        move["image_id"] = job["image_id"]
        if job["status"] == "pending":
            image_jobs.start(illustrations, boards, getattr(request.app.state, "board_http", None), owner, str(sid),
                             job["image_id"], move["prompt"])

    async def events():
        yield _event("turn", {"turn_id": str(body.turn_id), "kind": body.kind, "outcome": outcome and {
            k: outcome[k] for k in ("qid", "result")}})
        try:
            with anyio.fail_after(TURN_SECONDS):
                async for index, move in run.events():
                    if move["type"] == "image":
                        await illustrate(move)
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
                                        {**summary(run), "provider": tutor.timing, "usage": tutor.usage,
                                         "tutor": tutor.trace})
            log.info("tutor turn=%s kind=%s status=%s moves=%s dropped=%s repairs=%s timing=%s usage=%s",
                     body.turn_id, body.kind, run.status, len(run.moves), len(run.dropped), run.repairs,
                     {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()}, tutor.usage)
        question_value = question_of(run, str(body.turn_id))
        if run.error and run.status in ("failed", "incomplete"):
            yield _event("error", {"code": run.error, "message": MESSAGES.get(run.error, FALLBACK), "status": run.status})
        yield _event("done", {"status": run.status, "question": public_question(question_value) if question_value else None,
                              "timing": {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()},
                              "moves": len(run.moves), "dropped": len(run.dropped), "repairs": run.repairs, "usage": tutor.usage,
                              "tutor": tutor.trace, "memory": memory_brief})
    return EventSourceResponse(events(), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
