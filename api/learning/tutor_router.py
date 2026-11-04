"""Authenticated tutor turns: a question or an answer in, streamed board moves out."""
from __future__ import annotations

import json
import logging
import re
import time
from uuid import UUID

import anyio
import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import run_in_threadpool

from . import image_jobs, observations, pointing, profile, study, trace
from .board_contracts import ContextPacket
from .board_router import get_board_store
from .consolidate import NOTES_MODEL, NotesWriter, bridges, evidence_payload, keep_cited, keep_links, keep_named
from pydantic import Field

from .contracts import Contract, canonical, digest
from .decisions import ProviderFailure, evidence_labeler
from .learner_contracts import LearnerBrief
from .personas import PersonaStore
from .router import call_store, get_store, private_response, require_owner, require_viewer
from .storage import StoreError
from .tutor_models import OptionUnavailable, resolve, tutor_options, voice_options
from .tutor_moves import TurnValidator
from .tutor_provider import MetaTutor
from .tutor_storage import TutorStore, open_question
from .tutor_turn import (TurnInput, TurnRun, board_focus, build_messages, grade, public_move, public_question,
                         question_of, question_record, session_memory, summary, this_turn)

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
# A short question opening on a connective or pointing back with a pronoun continues the topic before it.
_FOLLOW_UP = re.compile(r"^\s*(and|also|but|so|then|ok|okay)\b|\b(it|its|that|this|these|those|they|them)\b", re.I)
FOLLOW_UP_WORDS = 10


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


def get_study(store=Depends(get_store)):
    return study.StudyStore(store)


def get_notes_writer(request: Request):
    return NotesWriter(getattr(request.app.state, "board_http", None))


class MemoryInput(Contract):
    memory: bool


class CloseInput(Contract):
    # Which of the viewer's minds keeps this session: "own", or a persona key the viewer has (or gets) a copy of.
    into: str | None = Field(default=None, pattern=r"^(own|[a-z]{1,32})$")


class HintInput(Contract):
    qid: str = Field(min_length=1, max_length=80)
    level: int = Field(ge=1, le=2)


def current_topic(history: list[dict], text: str = "") -> tuple[str, str | None]:
    """(what this turn is about, the earlier question it continues). A question naming a subject starts its own topic;
    "give me a graph", "and the heads?", "why is it sinusoidal?" and answers continue the latest one that named one."""
    earlier = next((t["input"].get("text", "") for t in reversed(history) if t["kind"] == "question"
                    and t["status"] != "failed" and profile.subject_words(t["input"].get("text", ""))), "")
    if profile.subject_words(text) and not (earlier and _FOLLOW_UP.search(text) and len(text.split()) <= FOLLOW_UP_WORDS):
        return text, None
    return earlier, earlier or None


def session_brief(profiles, owner: str, sid: str, topic: str, fresh: bool = False) -> tuple[LearnerBrief | None, bool]:
    """(brief for this turn, memory on). A new topic compiles its own brief; Memory off reads nothing."""
    state = profiles.memory(owner, sid)
    if state["status"] != "open":
        raise StoreError(409, "session_closed")
    if not state["memory"]:
        return None, False
    if state["brief"] and not fresh:
        return LearnerBrief.model_validate(state["brief"]), True
    revision, index = profiles.latest(owner)
    brief = profile.compile_brief(revision, index, topic, focused=True)
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
                          history: list[dict], hint_ids: tuple[str, ...] = ()) -> None:
    """Record the answer once and start labeling in the background. Never fails or delays the lesson."""
    try:
        row, created = await call_store(evidence.capture_answer, owner, sid, str(body.turn_id), question, outcome["answer"],
                                        outcome, observations.modality_of(body.via, body.choice), history, body.element_ids,
                                        ink_crops(body), hint_ids)
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


async def _review(store, body: TurnInput, question: dict, started: float):
    """A warm-up drawn from the learner's own earlier check: stored like any turn, so it waits and replays."""
    moves = study.review_moves(question)
    qid = f"{body.turn_id}.1"
    asked = {**question_record(moves[1], qid), "origin": "review"}
    await run_in_threadpool(store.finish, str(body.turn_id), "waiting", moves, asked, None,
                            {"review": body.concept, "total_ms": (time.perf_counter() - started) * 1000})
    yield _event("turn", {"turn_id": str(body.turn_id), "kind": "review", "outcome": None})
    for index, move in enumerate(moves):
        yield _event("move", {"index": index, "move": public_move(move, qid if index == 1 else None)})
    yield _event("done", {"status": "waiting", "question": public_question(asked), "moves": len(moves), "review": True})


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
async def state(sid: UUID, owner=Depends(require_owner), store=Depends(get_tutor_store), tutor=Depends(get_tutor),
                studies=Depends(get_study)):
    history = await call_store(store.history, owner, str(sid))
    question = open_question(history)
    shown = {**public_question(question), "hints": await call_store(studies.hints, str(sid), question["qid"])} if question else None
    return {"configured": tutor.configured, "model": tutor.model, "open": shown,
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


@router.get("/sessions/{sid}/trace")
async def session_trace(sid: UUID, owner=Depends(require_owner), store=Depends(get_tutor_store),
                        evidence=Depends(get_evidence), profiles=Depends(get_profiles), studies=Depends(get_study)):
    """Trace drawer: per-stage models and latency for this session, from timings the stages already store."""
    turns = await call_store(store.history, owner, str(sid))
    entries = await call_store(evidence.entries, owner, str(sid))
    hints = await call_store(studies.hint_timings, str(sid))
    sealed = await call_store(profiles.for_session, owner, str(sid))
    close = sealed and sealed["close"]
    return trace.session_trace(turns, hints, entries, close, "seed" if close and close.get("seed") else NOTES_MODEL)


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


@router.get("/profile/revisions")
async def profile_history(owner=Depends(require_owner), profiles=Depends(get_profiles), evidence=Depends(get_evidence)):
    """The learner map's input: the latest 20 revisions (ascending) and the questions and answers they rest on."""
    history = await call_store(profiles.history, owner, 20)
    ids = list(dict.fromkeys(str(i) for r in history for i in r.observation_ids))[-400:]
    events = await call_store(evidence.digest, owner, ids) if ids else []
    return {"revisions": [r.model_dump(mode="json") for r in history], "events": events}


@router.get("/sessions/{sid}/review")
async def review(sid: UUID, owner=Depends(require_owner), profiles=Depends(get_profiles), studies=Depends(get_study)):
    """Warm-up items due now (no model call): concepts from earlier sessions, each with a stored check to re-ask."""
    state = await call_store(profiles.memory, owner, str(sid))
    if state["status"] != "open":
        return {"items": []}
    revision, _ = await call_store(profiles.latest, owner)
    checks = await call_store(studies.latest_checks, owner, str(sid))
    skip = await call_store(studies.reviewed, owner, str(sid))
    return {"items": study.review_items(revision, checks, skip)}


@router.post("/sessions/{sid}/tutor/hints")
async def hint(sid: UUID, body: HintInput, owner=Depends(require_owner), store=Depends(get_tutor_store),
               studies=Depends(get_study), tutor=Depends(get_tutor), profiles=Depends(get_profiles)):
    """One rung of the hint ladder on the open card. Stored once per level; levels are taken in order."""
    state = await call_store(profiles.memory, owner, str(sid))
    if state["status"] != "open":
        raise HTTPException(409, "session_closed")
    question = open_question(await call_store(store.history, owner, str(sid)))
    if question is None or question["qid"] != body.qid:
        raise HTTPException(409, "tutor_question_not_open")
    given = await call_store(studies.hints, str(sid), body.qid)
    if any(h["level"] == body.level for h in given):
        return {"qid": body.qid, "hints": given, "replayed": True}
    if len(given) != body.level - 1:
        raise HTTPException(409, "hint_out_of_order")
    if not tutor.configured:
        raise HTTPException(503, "tutor_not_configured")
    await call_store(store.reserve, owner)
    started = time.perf_counter()
    try:
        content = await tutor.complete(study.hint_messages(question, body.level, given), study.HINT_TOKENS, study.HINT_FORMAT)
        text = study.parse_hint(content, question)
    except ProviderFailure as exc:
        raise HTTPException(502, exc.code) from None
    except StoreError as exc:
        raise HTTPException(exc.status, exc.code) from None
    timing = {"ms": round((time.perf_counter() - started) * 1000), "usage": tutor.usage, "tutor": tutor.trace}
    log.info("hint session=%s qid=%s level=%s ms=%s", sid, body.qid, body.level, timing["ms"])
    return {"qid": body.qid, "hints": await call_store(studies.keep_hint, str(sid), body.qid, body.level, text, timing),
            "ms": timing["ms"], "replayed": False}


@router.get("/canvases")
async def canvases(owner=Depends(require_owner), studies=Depends(get_study)):
    """Saved sessions to resume, newest first."""
    return {"canvases": await call_store(studies.canvases, owner)}


def _summary(revision, found, left, relabel, notes_trace, started) -> dict:
    touched = {(o.concept, o.dimension) for o in found}
    return {"session_id": str(revision.session_id), "revision": revision.revision, "sealed": len(found),
            "left_out": left, "relabel": relabel,
            "beliefs": [{"concept": b.concept, "dimension": b.dimension, "mean": round(b.mean, 3)}
                        for b in revision.beliefs if (b.concept, b.dimension) in touched],
            "misconceptions": [m.id for m in revision.misconceptions if m.status == "active"],
            "links": len([k for k in revision.links if k.first_revision == revision.revision]),
            "suspected": [m.id for m in revision.misconceptions if m.status == "suspected"],
            "notes": [n.text for n in revision.notes], "notes_trace": notes_trace,
            "ms": round((time.perf_counter() - started) * 1000)}


@router.post("/sessions/{sid}/close")
async def close(sid: UUID, body: CloseInput | None = None, owner=Depends(require_owner), viewer=Depends(require_viewer),
                capture=Depends(get_store), store=Depends(get_tutor_store), evidence=Depends(get_evidence),
                labeler=Depends(get_labeler), profiles=Depends(get_profiles), writer=Depends(get_notes_writer)):
    """Seal the session once: re-label what is open, reduce, add cited notes, write one revision. Replays change nothing.
    `into` first moves the open session to another of the viewer's minds (their own, or a persona copy)."""
    started = time.perf_counter()
    if body is not None and body.into is not None:
        personas = PersonaStore(capture)
        target = viewer if body.into == "own" else await call_store(personas.ensure_copy, viewer, body.into)
        if target != owner:
            sealed = await call_store(profiles.for_session, owner, str(sid))
            if sealed is None:
                await call_store(personas.transfer, str(sid), owner, target)
                owner = target
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
        notes, named, links, notes_trace = [], [], [], {}
        known = {b.concept for b in previous.beliefs} if previous else set()
        try:
            await call_store(store.reserve, owner)
            answers = await call_store(evidence.answers, str(sid))
            raw, notes_trace = await writer.write(evidence_payload(found, answers, beliefs, tuple(known)))
            notes, notes_trace["dropped"] = keep_cited(raw, {str(o.observation_id) for o in found})
            named, notes_trace["names_dropped"] = keep_named(raw, found, answers)
            links, notes_trace["links_dropped"] = keep_links(raw, found, known)
            links += bridges(named, found)
            notes_trace.update(kept=len(notes), named=[n["id"] for n in named], links=len(links))
        except (ProviderFailure, HTTPException) as exc:  # the revision is written without notes
            notes_trace = {"error": getattr(exc, "code", None) or str(exc.detail)}
        except Exception as exc:
            notes_trace = {"error": "notes_failed"}
            log.warning("teaching notes failed session=%s (%s)", sid, type(exc).__name__)

        def build(prev, idx):
            revision, new_index = profile.reduce(prev, idx, found, str(sid), notes,
                                                 NOTES_MODEL if notes or named or links else None, descriptions=texts,
                                                 named=named, links=links)
            return revision, new_index, _summary(revision, found, left, relabel, notes_trace, started)

        revision, summary, replayed = await call_store(profiles.write, owner, str(sid), build)
        log.info("session %s sealed revision=%s observations=%s notes=%s in %s ms", sid, revision.revision,
                 len(found), len(revision.notes), summary["ms"])
        mind = await call_store(PersonaStore(capture).name_of, owner)
        return {**summary, "profile_updated": True, "replayed": replayed, "persona": mind}
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
               evidence=Depends(get_evidence), labeler=Depends(get_labeler), profiles=Depends(get_profiles),
               studies=Depends(get_study)):
    started = time.perf_counter()
    try:
        option = resolve(body.model)
    except OptionUnavailable as exc:
        raise HTTPException(422, str(exc)) from None
    if body.model:
        tutor.use(option)
    if not tutor.configured and body.kind != "review":
        raise HTTPException(503, "tutor_not_configured")
    history = await call_store(store.history, owner, str(sid))
    topic, continues = current_topic(history, body.text if body.kind == "question" else "")
    brief, memory_on = await call_store(session_brief, profiles, owner, str(sid), topic, body.kind == "question" and not continues and bool(topic))
    question = open_question(history)
    if body.kind == "answer" and (question is None or question["qid"] != body.question_id):
        raise HTTPException(409, "tutor_question_not_open")
    if body.element_ids:
        await call_store(_human_ink, boards, owner, sid, body.element_ids)
    reviewed = None
    if body.kind == "review":
        reviewed = (await call_store(studies.latest_checks, owner, str(sid))).get(body.concept)
        if reviewed is None:
            raise HTTPException(404, "review_not_found")
    value = body.model_dump(mode="json", exclude={"board"})
    replay = await call_store(store.begin, owner, str(sid), str(body.turn_id), body.kind, value, digest(canonical(body)))
    if replay is not None:
        return EventSourceResponse(_replay(replay), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    if reviewed is not None:
        return EventSourceResponse(_review(store, body, reviewed, started),
                                   headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    outcome = grade(question, body) if body.kind == "answer" else None
    if outcome is not None:
        hint_ids = tuple(f"hint:{h['level']}" for h in await call_store(studies.hints, str(sid), question["qid"]))
        await record_evidence(evidence, labeler, owner, str(sid), body, question, outcome, history, hint_ids)
    concept = await call_store(studies.session_concept, str(sid)) if body.kind == "exit" else None
    run = None
    try:
        packet, images, sent = None, [], []
        if body.board is not None:
            packet = ContextPacket.model_validate(await call_store(boards.capture_context, owner, sid, body.board))
            for crop in packet.crops:
                if crop.purpose == "initial" and len(images) < 2:
                    asset = await call_store(boards.get_asset, owner, sid, crop.asset_hash)
                    images.append((asset["mime"], asset["content"]))
                    sent.append(crop.model_dump(mode="json"))
        await call_store(store.reserve, owner)
        messages = build_messages(profile.render_brief(brief), session_memory(history), board_focus(packet),
                                  this_turn(body, question, outcome, concept, continues), images)
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
                    elif move["type"] == "point":
                        # Stored with the move, so a replay draws the same ring with no new call.
                        move.update(pointing.resolve(move, sent[move["crop"]], packet.focused))
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
            question_value = question_of(run, str(body.turn_id), "exit" if body.kind == "exit" else None)
            with anyio.CancelScope(shield=True):
                await run_in_threadpool(store.finish, str(body.turn_id), run.status, run.moves, question_value, outcome,
                                        {**summary(run), "provider": tutor.timing, "usage": tutor.usage,
                                         "tutor": tutor.trace})
            log.info("tutor turn=%s kind=%s status=%s moves=%s dropped=%s repairs=%s timing=%s usage=%s",
                     body.turn_id, body.kind, run.status, len(run.moves), len(run.dropped), run.repairs,
                     {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()}, tutor.usage)
        question_value = question_of(run, str(body.turn_id), "exit" if body.kind == "exit" else None)
        if run.error and run.status in ("failed", "incomplete"):
            yield _event("error", {"code": run.error, "message": MESSAGES.get(run.error, FALLBACK), "status": run.status})
        yield _event("done", {"status": run.status, "question": public_question(question_value) if question_value else None,
                              "timing": {k: round(v) for k, v in {**run.timing, **tutor.timing}.items()},
                              "moves": len(run.moves), "dropped": len(run.dropped), "repairs": run.repairs, "usage": tutor.usage,
                              "tutor": tutor.trace, "memory": memory_brief})
    return EventSourceResponse(events(), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
