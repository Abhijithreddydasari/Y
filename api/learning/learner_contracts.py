"""Versioned learner-model boundaries: evidence, profile revisions, briefs and the Constellation.

Shared by evidence capture (H4), session consolidation (H5), the tutor context packet (H1) and
the Constellation view (H6). Changing a contract needs a note in the slice handoff.
"""
from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from .contracts import Assistance, Contract, Identifier, Probability

LEARNER_CONTRACTS_VERSION = "learner-v1"
LearningDimension = Literal["recall", "understand", "apply", "analyze", "transfer"]
LEARNING_DIMENSIONS: tuple[LearningDimension, ...] = ("recall", "understand", "apply", "analyze", "transfer")
Outcome = Literal["correct", "partial", "incorrect", "unanswered"]
MissClass = Literal["cue", "discrimination", "execution", "careless", "structural"]
Modality = Literal["tap", "typed", "spoken", "ink"]
KeyStatus = Literal["ok", "suspect", "wrong"]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
# Brief ids are what `because` moves cite: K known, S shaky, M misconception, P preference, N note.
BriefRef = Annotated[str, Field(pattern=r"^[KSMPN][0-9]{1,3}$")]
BRIEF_MAX_CHARS = 2400  # ~600 tokens at ~4 chars/token


class EvidenceSource(Contract):
    event_id: UUID
    modality: Modality
    content_hash: Sha256
    element_ids: tuple[Identifier, ...] = Field(default=(), max_length=200)
    # Tutor-authored content never counts as learner evidence.
    author: Literal["learner"] = "learner"


class Observation(Contract):
    """One labeled answer to a predict/check; idempotent on (session_id, check_id)."""
    schema_version: Literal[1] = 1
    observation_id: UUID
    session_id: UUID
    check_id: Identifier
    concept: Identifier
    dimension: LearningDimension
    outcome: Outcome
    misconception: Identifier | None = None
    miss_class: MissClass | None = None
    assistance: Assistance = Field(default_factory=Assistance)
    # Learner-reported confidence from the check card; None when not asked.
    confidence: Probability | None = None
    # "seed": authored demo-persona history (personas.py), never a live model label.
    labeler: Literal["deterministic", "baseten", "openai", "seed", "none"] = "none"
    label_confidence: Probability | None = None
    # The decision model's full distributions (H5 soft update). `outcome_p` is None when a verifier decided.
    outcome_p: dict[Outcome, Probability] | None = None
    # Named misconception candidates the model saw (p >= 0.05), and p of one not on the list.
    misconception_p: dict[Identifier, Probability] = Field(default_factory=dict, max_length=8)
    other_misconception_p: Probability | None = None
    # Quality of the reasoning shown (0 flawed .. 1 insightful) and p that any reasoning was visible.
    reasoning: Probability | None = None
    reasoning_shown: Probability | None = None
    # How much this answer format says about the learner (guessable taps and reveals weigh less).
    format_weight: Probability = 1.0
    # "wrong": a verifier showed the tutor's key was incorrect; reducers skip or down-weight it.
    key_status: KeyStatus = "ok"
    sources: tuple[EvidenceSource, ...] = Field(min_length=1, max_length=8)
    created_at: str

    @model_validator(mode="after")
    def consistent_outcome(self):
        if self.outcome == "correct" and (self.misconception or self.miss_class):
            raise ValueError("a correct answer has no misconception or miss class")
        if self.outcome == "unanswered" and self.miss_class:
            raise ValueError("an unanswered check has no miss class")
        return self


class BriefItem(Contract):
    id: BriefRef
    kind: Literal["known", "shaky", "misconception", "preference", "note"]
    concept: Identifier | None = None
    text: str = Field(min_length=1, max_length=280)
    evidence: tuple[UUID, ...] = Field(default=(), max_length=8)


class LearnerBrief(Contract):
    """Bounded per-topic summary placed in the tutor context packet (≤ ~600 tokens)."""
    schema_version: Literal[1] = 1
    brief_id: UUID
    topic: str = Field(min_length=1, max_length=160)
    profile_revision: int = Field(ge=0)
    items: tuple[BriefItem, ...] = Field(max_length=24)
    # Names of concepts studied on other topics: for reusing their ids, never teaching material.
    other_concepts: tuple[str, ...] = Field(default=(), max_length=60)

    @model_validator(mode="after")
    def bounded(self):
        if len({item.id for item in self.items}) != len(self.items):
            raise ValueError("duplicate brief id")
        if sum(len(item.text) for item in self.items) > BRIEF_MAX_CHARS:
            raise ValueError("brief exceeds its token budget")
        return self

    @property
    def refs(self) -> frozenset[str]:
        return frozenset(item.id for item in self.items)


class Belief(Contract):
    """Beta(alpha, beta) mastery belief for one concept × dimension."""
    concept: Identifier
    dimension: LearningDimension
    alpha: float = Field(gt=0, le=1e6)
    beta: float = Field(gt=0, le=1e6)
    half_life_hours: float | None = Field(default=None, gt=0, le=1e6)
    last_evidence_at: str | None = None

    @property
    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)


class MisconceptionEntry(Contract):
    id: Identifier
    concept: Identifier
    description: str = Field(min_length=1, max_length=400)
    # "suspected": probability mass below the active threshold so far.
    status: Literal["active", "suspected", "resolved"]
    # Accumulated probability that answers showed it; legacy entries count as one certain sighting.
    strength: float = Field(default=1.0, ge=0, le=1000)
    evidence: tuple[UUID, ...] = Field(min_length=1, max_length=32)


class TeachingNote(Contract):
    text: str = Field(min_length=1, max_length=400)
    # Notes that cite no observed events are dropped before they reach a revision.
    cites: tuple[UUID, ...] = Field(min_length=1, max_length=16)


class ConceptLink(Contract):
    """A reasoning link between two concepts shown by this learner's answers (H6). Explanatory only:
    links never change beliefs, the ledger or the brief. `confused_with` is unordered (source < target)."""
    source: Identifier
    target: Identifier
    kind: Literal["builds_on", "confused_with"]
    why: str = Field(min_length=1, max_length=240)
    strength: float = Field(ge=0, le=1000)
    evidence: tuple[UUID, ...] = Field(min_length=1, max_length=16)
    provenance: Literal["model", "system", "seed"]
    first_revision: int = Field(ge=1)

    @model_validator(mode="after")
    def distinct(self):
        if self.source == self.target:
            raise ValueError("a link needs two concepts")
        if self.kind == "confused_with" and self.source > self.target:
            raise ValueError("confused_with is stored with source < target")
        return self


class ProfileRevision(Contract):
    """Result of sealing one session; applying the same session twice is rejected upstream."""
    schema_version: Literal[1] = 1
    revision: int = Field(ge=1)
    parent_revision: int | None = Field(default=None, ge=1)
    session_id: UUID
    observation_ids: tuple[UUID, ...] = Field(max_length=2000)
    beliefs: tuple[Belief, ...] = Field(max_length=2000)
    misconceptions: tuple[MisconceptionEntry, ...] = Field(default=(), max_length=200)
    notes: tuple[TeachingNote, ...] = Field(default=(), max_length=40)
    links: tuple[ConceptLink, ...] = Field(default=(), max_length=200)
    consolidator: str | None = Field(default=None, max_length=120)
    created_at: str

    @model_validator(mode="after")
    def coherent(self):
        if self.parent_revision is not None and self.parent_revision >= self.revision:
            raise ValueError("parent revision must precede revision")
        if len({(b.concept, b.dimension) for b in self.beliefs}) != len(self.beliefs):
            raise ValueError("duplicate belief")
        if len(set(self.observation_ids)) != len(self.observation_ids):
            raise ValueError("duplicate observation")
        return self


NodeState = Literal["unseen", "learning", "shaky", "solid", "misconception"]


class DimensionState(Contract):
    dimension: LearningDimension
    mean: Probability
    evidence_count: int = Field(ge=0)


class ConstellationNode(Contract):
    id: Identifier
    label: str = Field(min_length=1, max_length=80)
    state: NodeState
    dimensions: tuple[DimensionState, ...] = Field(max_length=5)
    misconceptions: tuple[Identifier, ...] = Field(default=(), max_length=8)
    evidence: tuple[UUID, ...] = Field(default=(), max_length=64)
    due: bool = False

    @model_validator(mode="after")
    def unique_dimensions(self):
        if len({d.dimension for d in self.dimensions}) != len(self.dimensions):
            raise ValueError("duplicate dimension")
        return self


class ConstellationEdge(Contract):
    source: Identifier
    target: Identifier
    kind: Literal["prerequisite", "related"]


class GraphRevision(Contract):
    """Nodes changed at this revision, with their full state; the scrubber replays them in order."""
    revision: int = Field(ge=1)
    session_id: UUID
    created_at: str
    summary: str = Field(max_length=240)
    nodes: tuple[ConstellationNode, ...] = Field(max_length=150)


class ConstellationGraph(Contract):
    schema_version: Literal[1] = 1
    revision: int = Field(ge=0)
    nodes: tuple[ConstellationNode, ...] = Field(max_length=150)
    edges: tuple[ConstellationEdge, ...] = Field(max_length=600)
    revisions: tuple[GraphRevision, ...] = Field(default=(), max_length=200)

    @model_validator(mode="after")
    def connected(self):
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes):
            raise ValueError("duplicate node")
        for edge in self.edges:
            if edge.source == edge.target or edge.source not in ids or edge.target not in ids:
                raise ValueError(f"invalid edge {edge.source}->{edge.target}")
        numbers = [r.revision for r in self.revisions]
        if numbers != sorted(set(numbers)) or (numbers and numbers[-1] != self.revision):
            raise ValueError("revisions must ascend to the current revision")
        if any(node.id not in ids for r in self.revisions for node in r.nodes):
            raise ValueError("revision references an unknown node")
        return self
