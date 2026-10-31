"""Versioned boundaries shared by topic packs, providers and persistence."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Dimension = Literal["conceptual", "mathematical", "analytical", "critical", "delayed_retrieval"]
Label = Literal["supported", "contradicted", "not_observable", "ambiguous"]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False, strict=True)]
Identifier = Annotated[str, Field(min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9_.:/-]+$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical(value: BaseModel | dict) -> str:
    data = value.model_dump(mode="json") if isinstance(value, BaseModel) else value
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


class Concept(Contract):
    concept_id: Identifier
    title: str = Field(min_length=1, max_length=160)
    prerequisites: tuple[Identifier, ...] = ()


class Rubric(Contract):
    dimension: Dimension
    criterion: str = Field(min_length=1, max_length=2000)


class VerifierSpec(Contract):
    kind: Literal["weighted_sum", "stereo_depth", "eigenvalue"]
    parameters: dict[str, list[float] | float]
    version: str = "1"


class TaskSpec(Contract):
    task_id: Identifier
    pack_id: Identifier
    version: str = "1"
    prompt: str = Field(min_length=1, max_length=4000)
    concept_ids: tuple[Identifier, ...] = Field(min_length=1, max_length=12)
    rubrics: tuple[Rubric, ...] = Field(min_length=1, max_length=5)
    verifier: VerifierSpec | None = None
    sources: tuple[str, ...] = ()

    @model_validator(mode="after")
    def unique_dimensions(self):
        if len({r.dimension for r in self.rubrics}) != len(self.rubrics):
            raise ValueError("duplicate rubric dimension")
        return self


class TopicPack(Contract):
    pack_id: Identifier
    title: str
    version: str = "1"
    concepts: tuple[Concept, ...]
    tasks: tuple[TaskSpec, ...]


class WidgetSpec(Contract):
    widget_id: UUID
    kind: Literal["plot", "heatmap", "scene3d"]
    version: str = "1"
    # Validated widget-specific schemas will be registered with their renderer.
    state: dict


class Assistance(Contract):
    hint_ids: tuple[Identifier, ...] = Field(default=(), max_length=20)
    solution_revealed: bool = False
    self_reported_help: bool = False

    @property
    def independent(self) -> bool:
        return not (self.hint_ids or self.solution_revealed or self.self_reported_help)


class AttemptInput(Contract):
    attempt_id: UUID
    task_id: Identifier
    text: str = Field(max_length=8000)
    assistance: Assistance = Field(default_factory=Assistance)


class SourceRef(Contract):
    event_id: UUID
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    # UTF-8 text remains exact; offsets count Python Unicode code points.
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    author: Literal["learner"] = "learner"

    @model_validator(mode="after")
    def ordered(self):
        if self.end < self.start:
            raise ValueError("source span is reversed")
        return self


class CapturedAttempt(Contract):
    schema_version: Literal[1] = 1
    owner_id: str
    session_id: UUID
    attempt: AttemptInput
    task: TaskSpec
    source: SourceRef
    captured_at: str


class ChoiceResult(Contract):
    type: Literal["choice"]
    choice: Label
    probabilities: dict[Label, Probability]
    confidence: Probability

    @model_validator(mode="after")
    def valid_distribution(self):
        if set(self.probabilities) != {"supported", "contradicted", "not_observable", "ambiguous"}:
            raise ValueError("incomplete label distribution")
        if abs(sum(self.probabilities.values()) - 1) > 0.001:
            raise ValueError("probabilities must sum to one")
        if self.probabilities[self.choice] < max(self.probabilities.values()):
            raise ValueError("choice does not match distribution")
        return self


class Observation(Contract):
    dimension: Dimension
    label: Label
    status: Literal["accepted", "abstained", "pending_review"]
    reasons: tuple[str, ...]
    provider: Literal["deterministic", "jev", "baseten", "none"]
    model_version: str | None = None
    model_is_alias: bool = False
    probabilities: dict[Label, Probability] | None = None
    provider_confidence: Probability | None = None
    source: SourceRef


class Assessment(Contract):
    schema_version: Literal[1] = 1
    assessment_id: UUID
    attempt_id: UUID
    question_version: str = "capture-choice-v1"
    policy_version: str = "capture-shadow-v1"
    observations: tuple[Observation, ...]
    raw_result: dict | None = None
    provider_error: str | None = None
    latency_ms: float = Field(ge=0, allow_inf_nan=False)
    usage: dict[str, int] = Field(default_factory=dict)
    created_at: str
    # Capture never mutates the existing online learner/adapter.
    profile_updated: Literal[False] = False
