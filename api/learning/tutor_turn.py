"""One tutor turn: context packet, streamed moves, validation with a single repair, waiting state.

The packet is ordered for prefix caching: a constant system prefix, then the learner brief, then
session memory, then board focus, then this turn. Only the tail changes between turns.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .board_contracts import ContextInput, ContextPacket
from .board_context import model_context
from .contracts import Contract, canonical
from .decisions import ProviderFailure
from .tutor_moves import MOVES_SCHEMA_VERSION, MoveError, TurnValidator
from .tutor_stream import MoveStreamParser, MoveSyntaxError

log = logging.getLogger("y.tutor")
POLICY_VERSION = "tutor-v1"
SYSTEM_PREFIX = (Path(__file__).resolve().parents[1] / "prompts" / f"{POLICY_VERSION}.md").read_text(encoding="utf-8")
# Kinds the board renders; pointing arrives with H8 and `because` with H5.
ENABLED = frozenset({"seg", "write", "equation", "diagram", "widget", "say", "predict", "check", "turn_end"})
ONE_PER_TURN = ("diagram", "widget", "image")
MEMORY_BUDGET = 12 * 1024
RECENT_TURNS = 3
MAX_REPAIRS = 2
_NO_REPAIR = ("move after turn_end", "turn exceeds", "kind not enabled", "question must be the last move", "only one")


class TurnInput(Contract):
    turn_id: UUID
    kind: Literal["question", "answer"]
    text: str = Field(default="", max_length=2000)
    question_id: str | None = Field(default=None, max_length=80)
    choice: str | None = Field(default=None, max_length=200)
    confidence: int | None = Field(default=None, ge=0, le=100)
    reveal: bool = False
    model: str | None = Field(default=None, max_length=40, pattern=r"^[a-z0-9.\-]+$")
    board: ContextInput | None = None

    @model_validator(mode="after")
    def complete(self):
        if self.kind == "question" and not self.text.strip():
            raise ValueError("a question needs text")
        if self.kind == "answer" and (not self.question_id or not (self.choice or self.text.strip() or self.reveal)):
            raise ValueError("an answer needs a question id and a choice, text or reveal")
        return self


def question_record(move: dict, qid: str) -> dict:
    """Server-side copy of a predict/check; holds the key, which never reaches the browser early."""
    if move["type"] == "predict":
        return {"qid": qid, "kind": "predict", "q": move["q"], "options": move["options"], "key": move["answer"],
                "concept": None, "dim": None}
    return {"qid": qid, "kind": move["kind"], "q": move["q"], "options": move["options"], "key": move["key"],
            "concept": move["concept"], "dim": move["dim"]}


def public_move(move: dict, qid: str | None = None) -> dict:
    if move["type"] in ("predict", "check"):
        return {"type": move["type"], "kind": move.get("kind", "mcq"), "q": move["q"], "options": move["options"], "qid": qid}
    return move


def public_question(question: dict) -> dict:
    return {key: question[key] for key in ("qid", "kind", "q", "options")}


def grade(question: dict, turn: TurnInput) -> dict:
    """Deterministic result where one exists; free answers are judged by the tutor in context."""
    answer = (turn.choice or turn.text).strip()
    if turn.reveal:
        result = "revealed"
    elif question["kind"] in ("predict", "mcq"):
        result = "correct" if answer == question["key"] else "incorrect"
    else:
        result = "correct" if answer.casefold() == question["key"].strip().casefold() else "unverified"
    return {"qid": question["qid"], "concept": question["concept"], "dim": question["dim"], "result": result,
            "answer": answer, "confidence": turn.confidence}


def _learner(turn: dict) -> dict:
    value = turn["input"]
    if turn["kind"] == "question":
        return {"asked": value["text"]}
    return {"answered": value.get("choice") or value.get("text") or "", "result": (turn["outcome"] or {}).get("result"),
            "confidence": value.get("confidence")}


def session_memory(history: list[dict]) -> dict:
    """Lesson map, last turns verbatim, compact older turns; bounded to MEMORY_BUDGET bytes."""
    done = [t for t in history if t["status"] != "failed"]
    goals = [m["goal"] for t in done for m in t["moves"] if m["type"] == "seg"]
    recent = [{"turn": t["seq"], "learner": _learner(t), "tutor": t["moves"], "status": t["status"]} for t in done[-RECENT_TURNS:]]
    older = [{"turn": t["seq"], "learner": _learner(t), "goals": [m["goal"] for m in t["moves"] if m["type"] == "seg"],
              "asked": (t["question"] or {}).get("q")} for t in done[:-RECENT_TURNS]]
    memory = {"lesson_map": goals[-24:], "older_turns": older[-12:], "recent_turns": recent}
    while len(canonical(memory).encode("utf-8")) > MEMORY_BUDGET and (memory["older_turns"] or len(memory["recent_turns"]) > 1):
        if memory["older_turns"]:
            memory["older_turns"].pop(0)
        else:
            memory["recent_turns"].pop(0)
    return memory


def board_focus(packet: ContextPacket | None) -> dict:
    if packet is None:
        return {"focused": [], "note": "board not sent"}
    value = model_context(packet)
    value.pop("question", None)
    # Earlier tutor output is in session memory; send only what the learner (or an import) put there.
    value["focused"] = [f for f in value["focused"] if f["creator"] != "model"]
    return value


def this_turn(turn: TurnInput, question: dict | None, outcome: dict | None) -> dict:
    if turn.kind == "question":
        value = {"kind": "question", "text": turn.text.strip()}
        if question:
            value["note"] = f"The open question was not answered: {question['q']}"
        return value
    return {"kind": "answer", "question": {k: question[k] for k in ("kind", "q", "options", "key")},
            "learner_answer": outcome["answer"], "confidence": turn.confidence, "result": outcome["result"]}


def build_messages(brief: str, memory: dict, board: dict, turn: dict, images: list[tuple[str, bytes]] = ()) -> list[dict]:
    content = [{"type": "text", "text": "LEARNER BRIEF\n" + (brief or "none yet")},
               {"type": "text", "text": "SESSION MEMORY\n" + canonical(memory)},
               {"type": "text", "text": "BOARD FOCUS\n" + canonical(board)}]
    for mime, data in images:
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}})
    content.append({"type": "text", "text": "THIS TURN\n" + canonical(turn)})
    return [{"role": "system", "content": SYSTEM_PREFIX}, {"role": "user", "content": content}]


def _repair_messages(raw: str, error: str) -> list[dict]:
    return [{"role": "system", "content": SYSTEM_PREFIX},
            {"role": "user", "content": f"One move you wrote was rejected: {error}. Rejected move: {raw[:3000]}\n"
                                        'Return {"moves": [one corrected move of the same type]} and nothing else.'}]


class TurnRun:
    """Streams accepted moves for one turn. Iterate `events()`; read `status` afterwards."""

    def __init__(self, tutor, messages: list[dict], validator: TurnValidator, reserve=None, started: float | None = None):
        self.tutor, self.messages, self.validator, self.reserve = tutor, messages, validator, reserve
        self.started = started or time.perf_counter()
        self.moves: list[dict] = []
        self.dropped: list[str] = []
        self.question_index: int | None = None
        self.repairs = 0
        self.error: str | None = None
        self.status = "streaming"
        self.timing: dict[str, float] = {}

    def _rules(self, value: dict) -> None:
        kind = value.get("type") if isinstance(value, dict) else None
        if kind not in ENABLED:
            raise MoveError(f"kind not enabled: {kind}")
        if self.validator.question and kind != "turn_end":
            raise MoveError("question must be the last move")
        if kind in ONE_PER_TURN and any(m["type"] == kind for m in self.moves):
            raise MoveError(f"only one {kind} per turn")

    async def _accept(self, element) -> dict | None:
        raw, value, error = element.raw, element.value, element.error
        if error is None:
            try:
                self._rules(value)
                return self.validator.accept(value).model_dump(mode="json")
            except MoveError as exc:
                error = str(exc)
        if self.repairs < MAX_REPAIRS and not error.startswith(_NO_REPAIR):
            self.repairs += 1
            try:
                if self.reserve:
                    await self.reserve()
                fixed = json.loads(await self.tutor.complete(_repair_messages(raw, error)))["moves"][0]
                if isinstance(value, dict) and fixed.get("type") != value.get("type"):
                    raise MoveError("repair changed the move type")
                self._rules(fixed)
                move = self.validator.accept(fixed).model_dump(mode="json")
                log.info("tutor move %s repaired: %s", element.index, error)
                return move
            except (MoveError, ProviderFailure, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
                error = f"{error}; repair failed ({getattr(exc, 'code', None) or type(exc).__name__})"
        self.dropped.append(f"move {element.index}: {error}")
        log.warning("tutor move %s dropped: %s", element.index, error)
        return None

    async def events(self):
        queue: asyncio.Queue = asyncio.Queue()

        async def produce():
            parser = MoveStreamParser()
            try:
                async for chunk in self.tutor.stream(self.messages):
                    for element in parser.feed(chunk):
                        queue.put_nowait(element)
                parser.close()
                queue.put_nowait(None)
            except (ProviderFailure, MoveSyntaxError) as exc:
                queue.put_nowait(exc)

        producer = asyncio.create_task(produce())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, BaseException):
                    self.error = getattr(item, "code", None) or "turn_malformed"
                    log.warning("tutor stream ended early: %s", self.error if self.error != "turn_malformed" else item)
                    break
                move = await self._accept(item)
                if move is None:
                    continue
                index = len(self.moves)
                self.moves.append(move)
                if move["type"] in ("predict", "check"):
                    self.question_index = index
                if index == 0:
                    self.timing["first_move_ms"] = (time.perf_counter() - self.started) * 1000
                # Keep reading after turn_end: only the closing brackets and the usage report follow.
                yield index, move
        finally:
            producer.cancel()
            try:
                await producer
            except (asyncio.CancelledError, Exception):
                pass
        self.status = self.final_status()

    def final_status(self) -> str:
        if self.question_index is not None:
            return "waiting"
        if self.error:
            return "incomplete" if self.moves else "failed"
        try:
            self.validator.finish()
        except MoveError as exc:
            self.dropped.append(str(exc))
        return "done"


def question_of(run: TurnRun, turn_id: str) -> dict | None:
    if run.question_index is None:
        return None
    return question_record(run.moves[run.question_index], f"{turn_id}.{run.question_index}")


def summary(run: TurnRun) -> dict:
    return {"schema": MOVES_SCHEMA_VERSION, "policy": POLICY_VERSION, "moves": len(run.moves),
            "dropped": run.dropped[:10], "repairs": run.repairs, "error": run.error, **run.timing}
