"""Versioned tutor move contract: strict JSON schema for `{"moves": [...]}` plus semantic validation.

The provider's strict mode guarantees shape only. `TurnValidator` checks meaning one move at a
time so the stream can render, repair or drop each move as it closes. Free-form widget specs
are JSON-encoded strings because strict mode allows no open objects.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Annotated, Literal, Union, get_args, get_origin

from annotated_types import MaxLen, MinLen
from pydantic import BaseModel, Field, TypeAdapter, ValidationError, field_validator, model_validator

from .contracts import Contract, Identifier
from .learner_contracts import LearningDimension

MOVES_SCHEMA_VERSION = "tutor-moves.v1"
MOVE_KINDS = ("seg", "write", "equation", "diagram", "widget", "image", "say", "predict", "check",
              "because", "point", "turn_end")
WidgetKind = Literal["plot", "attention", "matrix", "stepper"]
MAX_MOVES = 40
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / f"{MOVES_SCHEMA_VERSION}.json"

Text = Annotated[str, Field(min_length=1, max_length=400)]
Option = Annotated[str, Field(min_length=1, max_length=200)]

# A provider that under-escapes LaTeX turns `\frac` into form feed + "rac". These control
# characters never belong in LaTeX; newline/CR are restored only before a known macro tail.
_LATEX_CONTROL = re.compile(r"[\x08\x09\x0c]|\n(?=abla|eq|eg|ot|u\b|e\b|i\b|mid|exists|leq|geq|atural)"
                            r"|\r(?=ho|ight|angle|ceil|floor|brace|vert|m\b)")
_LATEX_ESCAPE = {"\x08": "\\b", "\x09": "\\t", "\x0c": "\\f", "\n": "\\n", "\r": "\\r"}


def restore_latex(value: str) -> str:
    return _LATEX_CONTROL.sub(lambda m: _LATEX_ESCAPE[m.group()], value)


class Seg(Contract):
    type: Literal["seg"]
    id: Identifier = Field(max_length=40)
    goal: Text


class Write(Contract):
    type: Literal["write"]
    text: Text


class Equation(Contract):
    type: Literal["equation"]
    latex: str = Field(min_length=1, max_length=2000)

    _restore = field_validator("latex")(restore_latex)


class Diagram(Contract):
    type: Literal["diagram"]
    mermaid: str = Field(min_length=1, max_length=4000, description="Mermaid flowchart source")


class Widget(Contract):
    type: Literal["widget"]
    kind: WidgetKind
    spec: str = Field(min_length=2, max_length=8000, description="JSON-encoded spec object")


class Image(Contract):
    type: Literal["image"]
    prompt: str = Field(min_length=1, max_length=1000, description="Illustration only; never the source of math")
    alt: Text


class Say(Contract):
    type: Literal["say"]
    text: str = Field(min_length=1, max_length=2000)


class Predict(Contract):
    type: Literal["predict"]
    q: Text
    options: list[Option] = Field(min_length=2, max_length=4)
    answer: Option


class Check(Contract):
    type: Literal["check"]
    kind: Literal["mcq", "free"]
    q: Text
    key: Option
    concept: Identifier
    dim: LearningDimension
    options: list[Option] = Field(max_length=5, description="2-5 for mcq, empty for free")


class Because(Contract):
    type: Literal["because"]
    refs: list[str] = Field(min_length=1, max_length=4, description="Learner brief ids")
    text: Text


class Point(Contract):
    type: Literal["point"]
    crop: int = Field(ge=0, le=3, description="Index of a crop in the context packet")
    x: int = Field(ge=0, le=1000)
    y: int = Field(ge=0, le=1000)
    line: int = Field(ge=0, le=500, description="1-based line in the learner's work, 0 if unknown")
    label: Text


class TurnEnd(Contract):
    type: Literal["turn_end"]
    reason: Literal["wait", "done"]


MOVE_MODELS: tuple[type[Contract], ...] = (Seg, Write, Equation, Diagram, Widget, Image, Say, Predict,
                                           Check, Because, Point, TurnEnd)
TutorMove = Annotated[Union[Seg, Write, Equation, Diagram, Widget, Image, Say, Predict, Check, Because,
                            Point, TurnEnd], Field(discriminator="type")]
_MOVE = TypeAdapter(TutorMove)


# Widget specs: widgets compute derived values (scores, eigenvalues) themselves.
class Param(Contract):
    min: float
    max: float
    value: float

    @model_validator(mode="after")
    def ordered(self):
        if not self.min <= self.value <= self.max or self.min == self.max:
            raise ValueError("parameter needs min <= value <= max")
        return self


class PlotSpec(Contract):
    expr: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_+\-*/^().,\s]+$")
    x: tuple[float, float]
    params: dict[Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,15}$")], Param] = Field(max_length=6)

    @model_validator(mode="after")
    def domain(self):
        if self.x[0] >= self.x[1]:
            raise ValueError("x range must ascend")
        return self


class AttentionSpec(Contract):
    tokens: list[Annotated[str, Field(min_length=1, max_length=24)]] = Field(min_length=2, max_length=12)
    temp: float = Field(gt=0, le=100)


class MatrixSpec(Contract):
    m: list[list[float]] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def rectangular(self):
        if len({len(row) for row in self.m}) != 1 or not 1 <= len(self.m[0]) <= 6:
            raise ValueError("matrix must be rectangular, at most 6x6")
        return self


class StepperSpec(Contract):
    steps: list[Annotated[str, Field(min_length=1, max_length=600)]] = Field(min_length=2, max_length=12)

    _restore = field_validator("steps")(lambda steps: [restore_latex(s) for s in steps])


WIDGET_SPECS: dict[str, type[Contract]] = {"plot": PlotSpec, "attention": AttentionSpec,
                                           "matrix": MatrixSpec, "stepper": StepperSpec}


def _field_schema(annotation, metadata=()) -> dict:
    if get_origin(annotation) is Annotated:
        base, *extra = get_args(annotation)
        return _field_schema(base, [m for e in extra for m in getattr(e, "metadata", [e])])
    if get_origin(annotation) is Literal:
        return {"type": "string", "enum": list(get_args(annotation))}
    if get_origin(annotation) is list:
        out = {"type": "array", "items": _field_schema(get_args(annotation)[0])}
        for m in metadata:
            if isinstance(m, MinLen) and m.min_length:
                out["minItems"] = m.min_length
            elif isinstance(m, MaxLen):
                out["maxItems"] = m.max_length
        return out
    return {"type": {str: "string", int: "integer", float: "number"}[annotation]}


def move_schema() -> dict:
    """Strict-mode schema: every property required, no additional properties anywhere."""
    variants = []
    for model in MOVE_MODELS:
        props = {}
        for name, info in model.model_fields.items():
            props[name] = _field_schema(info.annotation, info.metadata)
            if info.description:
                props[name]["description"] = info.description
        variants.append({"type": "object", "properties": props, "required": list(props),
                         "additionalProperties": False})
    return {"type": "object", "properties": {"moves": {"type": "array", "items": {"anyOf": variants}}},
            "required": ["moves"], "additionalProperties": False}


def response_format() -> dict:
    return {"type": "json_schema", "json_schema": {"name": "tutor_turn", "strict": True, "schema": move_schema()}}


def write_schema(path: Path = SCHEMA_PATH) -> None:
    path.write_text(json.dumps(move_schema(), indent=2) + "\n", encoding="utf-8")


class MoveError(ValueError):
    """A move that must not render; the message is safe to include in a repair request."""


def _compact(error: ValidationError) -> str:
    first = error.errors(include_url=False)[0]
    return f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}"


class TurnValidator:
    """Semantic checks for one turn, fed move by move in stream order."""

    __slots__ = ("brief_refs", "crops", "count", "segments", "check", "question", "ended")

    def __init__(self, brief_refs: frozenset[str] = frozenset(), crops: int = 0):
        self.brief_refs = brief_refs
        self.crops = crops
        self.count = 0
        self.segments: set[str] = set()
        self.check = False
        self.question = False
        self.ended = False

    def accept(self, raw: dict) -> BaseModel:
        """Return the parsed move or raise MoveError; state changes only on acceptance."""
        if self.ended:
            raise MoveError("move after turn_end")
        if self.count >= MAX_MOVES:
            raise MoveError(f"turn exceeds {MAX_MOVES} moves")
        try:
            move = _MOVE.validate_python(raw)
        except ValidationError as error:
            raise MoveError(_compact(error)) from None
        self._semantic(move)
        self.count += 1
        if isinstance(move, Seg):
            self.segments.add(move.id)
        elif isinstance(move, (Check, Predict)):
            self.question = True
            self.check = self.check or isinstance(move, Check)
        elif isinstance(move, TurnEnd):
            self.ended = True
        return move

    def _semantic(self, move: BaseModel) -> None:
        if isinstance(move, Seg) and move.id in self.segments:
            raise MoveError(f"duplicate segment id {move.id}")
        if isinstance(move, Predict):
            if len(set(move.options)) != len(move.options):
                raise MoveError("predict options repeat")
            if move.answer not in move.options:
                raise MoveError("predict answer is not one of its options")
        elif isinstance(move, Check):
            if self.check:
                raise MoveError("only one check per turn")
            if move.kind == "mcq":
                if len(move.options) < 2 or len(set(move.options)) != len(move.options):
                    raise MoveError("mcq needs 2-5 distinct options")
                if move.key not in move.options:
                    raise MoveError("mcq key is not one of its options")
            elif move.options:
                raise MoveError("free check takes no options")
        elif isinstance(move, Because):
            unknown = [ref for ref in move.refs if ref not in self.brief_refs]
            if unknown:
                raise MoveError(f"because cites refs not in the brief: {', '.join(unknown)}")
        elif isinstance(move, Widget):
            try:
                spec = json.loads(move.spec)
            except json.JSONDecodeError:
                raise MoveError("widget spec is not valid JSON") from None
            if not isinstance(spec, dict):
                raise MoveError("widget spec must be a JSON object")
            try:
                WIDGET_SPECS[move.kind].model_validate(spec)
            except ValidationError as error:
                raise MoveError(f"{move.kind} spec {_compact(error)}") from None
        elif isinstance(move, Point) and move.crop >= self.crops:
            raise MoveError("point references a crop that was not sent")
        elif isinstance(move, TurnEnd):
            if self.check and move.reason != "wait":
                raise MoveError("a turn with a check must end with wait")
            if move.reason == "wait" and not self.question:
                raise MoveError("wait requires a predict or check")

    def finish(self) -> None:
        if not self.ended:
            raise MoveError("turn did not end with turn_end")


def validate_turn(document: dict, brief_refs: frozenset[str] = frozenset(),
                  crops: int = 0) -> tuple[list[BaseModel], list[str]]:
    """Non-streaming convenience: accepted moves plus one error per dropped move."""
    validator, moves, errors = TurnValidator(brief_refs, crops), [], []
    for index, raw in enumerate(document.get("moves") or []):
        try:
            moves.append(validator.accept(raw))
        except MoveError as error:
            errors.append(f"move {index}: {error}")
    try:
        validator.finish()
    except MoveError as error:
        errors.append(str(error))
    return moves, errors


if __name__ == "__main__":
    write_schema()
