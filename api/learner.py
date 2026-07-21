"""Versioned, probabilistic learner-state service.

This module owns three distinct concerns:

* a validated open-vocabulary evidence contract;
* a durable per-user event/state/fast-weight store;
* guarded Level-2 test-time adaptation of :mod:`learner_adapter`.

The lesson LLM never becomes the learner model.  It supplies uncertain
observations; the adapter combines them over time and emits a compact profile
that can be injected into any teacher provider.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import random
import re
import shutil
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import ollama
import torch
from safetensors.torch import load_file, save_file
from torch import Tensor
from torch.nn import functional as F

from learner_adapter import (
    AdapterConfig,
    LearnerAdapterModel,
    clone_fast_weights,
    load_adapter,
)


SCHEMA_VERSION = 2
EMBED_MODEL_DEFAULT = "nomic-embed-text"
EVIDENCE_THRESHOLD = 0.65
ADAPTER_CHECKPOINT_DEFAULT = (
    Path(__file__).resolve().parent.parent
    / "models"
    / "learner-adapter-v1.safetensors"
)
_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "learners"
DATA_DIR = (
    Path(os.environ["LEARNER_STORE_DIR"]).expanduser()
    if os.environ.get("LEARNER_STORE_DIR")
    else _DEFAULT_DATA_DIR
)


EXTRACT_SYSTEM_PROMPT = """You are an instructional analyst.

Extract the concepts covered by the whiteboard lesson. Reply with one JSON
object and no markdown:
{
  "topic": "short topic",
  "concepts_seen": ["open-vocabulary-concept"],
  "summary": "one sentence"
}
Use concrete 1-3 word concept names rather than broad school subjects.
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clamp01(value: object, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    if not math.isfinite(number):
        number = default
    return max(0.0, min(1.0, number))


def _clean_text(value: object, limit: int = 500) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _clean_concept_name(value: object) -> str:
    text = _clean_text(value, 80).lower()
    text = re.sub(r"[^a-z0-9+.# /_-]+", "", text)
    return re.sub(r"\s+", "-", text).strip("-_")[:64]


def _hash_embedding(text: str, width: int = 768) -> list[float]:
    """Stable, dependency-free fallback when the embedding daemon is absent.

    It is intentionally not presented as a semantic embedding.  It keeps
    persistence, tests, and online updates operational while `/health`
    reports that the semantic encoder is unavailable.
    """
    values = [0.0] * width
    tokens = re.findall(r"[a-z0-9]+", text.lower()) or [text.lower() or "empty"]
    for token in tokens:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=16).digest()
        for offset in range(0, 16, 4):
            raw = int.from_bytes(digest[offset:offset + 4], "little")
            index = raw % width
            values[index] += -1.0 if raw & 1 else 1.0
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


@dataclass
class EvidenceConcept:
    name: str
    description: str = ""
    confidence: float = 1.0
    embedding: list[float] = field(default_factory=list)


@dataclass
class OutcomeDistribution:
    correct: float = 1 / 3
    partial: float = 1 / 3
    incorrect: float = 1 / 3

    @classmethod
    def normalised(cls, value: object) -> "OutcomeDistribution":
        source = value if isinstance(value, dict) else {}
        correct = _clamp01(source.get("correct"), 1 / 3)
        partial = _clamp01(source.get("partial"), 1 / 3)
        incorrect = _clamp01(source.get("incorrect"), 1 / 3)
        total = correct + partial + incorrect
        if total <= 1e-8:
            return cls()
        return cls(correct / total, partial / total, incorrect / total)

    @property
    def soft_score(self) -> float:
        return self.correct + 0.5 * self.partial


@dataclass
class LearningEvidence:
    evidence_id: str
    user_id: str
    conversation_id: str
    source: str
    timestamp: str
    concepts: list[EvidenceConcept]
    outcome: OutcomeDistribution
    independence: float
    evidence_strength: float
    response_summary: str = ""
    misconception: str = ""
    task_text: str = ""
    response_text: str = ""
    event_embedding: list[float] = field(default_factory=list)
    embedding_source: str = ""

    @property
    def adapts_fast_weights(self) -> bool:
        return (
            self.source == "checkpoint_answer"
            and self.evidence_strength >= EVIDENCE_THRESHOLD
            and bool(self.concepts)
        )

    def event_text(self) -> str:
        concepts = ", ".join(
            f"{c.name}: {c.description}" if c.description else c.name
            for c in self.concepts
        )
        return (
            f"source={self.source}; concepts={concepts}; task={self.task_text}; "
            f"response={self.response_text or self.response_summary}; "
            f"misconception={self.misconception or 'none'}"
        )

    def numeric_features(self) -> list[float]:
        return [
            self.outcome.correct,
            self.outcome.partial,
            self.outcome.incorrect,
            self.independence,
            self.evidence_strength,
            1.0 if self.source == "checkpoint_answer" else 0.0,
            1.0 if self.source == "help_request" else 0.0,
            min(1.0, len(self.concepts) / 6.0),
        ]

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict) -> "LearningEvidence":
        return cls(
            evidence_id=str(value.get("evidence_id", "")),
            user_id=str(value.get("user_id", "anon")),
            conversation_id=str(value.get("conversation_id", "default")),
            source=str(value.get("source", "help_request")),
            timestamp=str(value.get("timestamp", _now())),
            concepts=[
                EvidenceConcept(
                    name=str(c.get("name", "")),
                    description=str(c.get("description", "")),
                    confidence=_clamp01(c.get("confidence"), 1.0),
                    embedding=list(c.get("embedding") or []),
                )
                for c in value.get("concepts", [])
                if isinstance(c, dict) and c.get("name")
            ],
            outcome=OutcomeDistribution.normalised(value.get("outcome")),
            independence=_clamp01(value.get("independence"), 0.5),
            evidence_strength=_clamp01(value.get("evidence_strength"), 0.0),
            response_summary=str(value.get("response_summary", "")),
            misconception=str(value.get("misconception", "")),
            task_text=str(value.get("task_text", "")),
            response_text=str(value.get("response_text", "")),
            event_embedding=list(value.get("event_embedding") or []),
            embedding_source=str(value.get("embedding_source", "")),
        )


@dataclass
class SessionRecord:
    ts: str
    topic: str
    primitives_count: int
    concepts_seen: list[str] = field(default_factory=list)
    mastered: list[str] = field(default_factory=list)
    struggling: list[str] = field(default_factory=list)
    summary: str = ""
    embedding: list[float] = field(default_factory=list)


@dataclass
class LearnerProfile:
    user_id: str
    schema_version: int = SCHEMA_VERSION
    state_revision: int = 0
    sessions: list[dict] = field(default_factory=list)
    evidence: list[dict] = field(default_factory=list)
    latent_trajectory: list[dict] = field(default_factory=list)
    checkpoints: list[dict] = field(default_factory=list)
    last_state: dict = field(default_factory=dict)
    last_activity: dict = field(default_factory=dict)
    adapter: dict = field(default_factory=lambda: {
        "base_version": AdapterConfig().version,
        "online_steps": 0,
        "rollback_count": 0,
        "representation_steps": 0,
        "representation_rollbacks": 0,
        "trained_checkpoint": False,
    })

    def mastery_summary(self, max_items: int = 6) -> dict[str, list[str]]:
        beliefs = list(self.last_state.get("concept_beliefs") or [])
        mastered = [b["name"] for b in beliefs if b.get("mastery_mean", 0.5) >= 0.7]
        struggling = [b["name"] for b in beliefs if b.get("mastery_mean", 0.5) <= 0.42]
        seen = [
            b["name"]
            for b in beliefs
            if b["name"] not in mastered and b["name"] not in struggling
        ]
        if beliefs:
            return {
                "mastered": mastered[:max_items],
                "struggling": struggling[:max_items],
                "seen": seen[:max_items],
            }
        # Compatibility for legacy profiles before their first v2 update.
        legacy_seen: list[str] = []
        for session in reversed(self.sessions[-20:]):
            for concept in session.get("concepts_seen") or []:
                if concept not in legacy_seen:
                    legacy_seen.append(concept)
        return {"mastered": [], "struggling": [], "seen": legacy_seen[:max_items]}

    def to_dict(self) -> dict:
        return asdict(self)


def normalise_evidence(
    raw: object,
    *,
    user_id: str,
    conversation_id: str,
    source: str,
) -> LearningEvidence:
    value = raw if isinstance(raw, dict) else {}
    raw_concepts = value.get("concepts") or value.get("concepts_seen") or []
    if isinstance(raw_concepts, str):
        raw_concepts = [raw_concepts]
    concepts: list[EvidenceConcept] = []
    seen: set[str] = set()
    for raw_concept in list(raw_concepts)[:8]:
        if isinstance(raw_concept, dict):
            name = _clean_concept_name(raw_concept.get("name"))
            description = _clean_text(raw_concept.get("description"), 160)
            confidence = _clamp01(raw_concept.get("confidence"), 1.0)
        else:
            name = _clean_concept_name(raw_concept)
            description = ""
            confidence = 1.0
        if name and name not in seen:
            concepts.append(EvidenceConcept(name, description, confidence))
            seen.add(name)
    if not concepts:
        topic = _clean_concept_name(value.get("topic"))
        if topic:
            concepts.append(EvidenceConcept(topic, "", 0.5))

    safe_source = source if source in {"help_request", "checkpoint_answer", "legacy"} else "help_request"
    evidence_id = "ev_" + hashlib.sha256(
        f"{user_id}|{conversation_id}|{_now()}|{random.random()}".encode("utf-8")
    ).hexdigest()[:16]
    return LearningEvidence(
        evidence_id=evidence_id,
        user_id=user_id,
        conversation_id=conversation_id or "default",
        source=safe_source,
        timestamp=_now(),
        concepts=concepts,
        outcome=OutcomeDistribution.normalised(value.get("outcome")),
        independence=_clamp01(value.get("independence"), 0.25 if safe_source == "help_request" else 0.5),
        evidence_strength=_clamp01(
            value.get("evidence_strength"),
            0.15 if safe_source in {"help_request", "legacy"} else 0.5,
        ),
        response_summary=_clean_text(value.get("response_summary") or value.get("summary"), 500),
        misconception=_clean_text(value.get("misconception"), 300),
        task_text=_clean_text(value.get("task_text"), 1000),
        response_text=_clean_text(value.get("response_text"), 1000),
    )


class LearnerStore:
    """File-backed learner state plus a shared frozen base adapter."""

    def __init__(
        self,
        root: Path = DATA_DIR,
        embed_model: str | None = None,
        adapter_checkpoint: Path | None = None,
        device: str | None = None,
        adapter_config: AdapterConfig | None = None,
    ) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._embed_model = embed_model or os.environ.get("EMBED_MODEL", EMBED_MODEL_DEFAULT)
        self._client: ollama.Client | None = None
        self._cache: dict[str, LearnerProfile] = {}
        self._fast_cache: dict[str, dict[str, Tensor]] = {}
        selected_device = device or os.environ.get("ADAPTER_DEVICE") or (
            "cuda" if torch.cuda.is_available() else "cpu"
        )
        self._device = torch.device(selected_device)
        selected_checkpoint = adapter_checkpoint or Path(
            os.environ.get("LEARNER_ADAPTER_CHECKPOINT", ADAPTER_CHECKPOINT_DEFAULT)
        ).expanduser()
        self._model, self._trained_checkpoint = load_adapter(
            selected_checkpoint,
            device=self._device,
            cfg=adapter_config,
        )
        self._adapter_checkpoint = selected_checkpoint

    @property
    def adapter_info(self) -> dict:
        fast_count = sum(
            tensor.numel()
            for tensor in self._model.init_fast_weights(device="cpu").values()
        )
        return {
            "version": self._model.cfg.version,
            "parameter_count": self._model.parameter_count,
            "fast_parameter_count": fast_count,
            "trained_checkpoint": self._trained_checkpoint,
            "checkpoint": str(self._adapter_checkpoint),
            "evidence_threshold": EVIDENCE_THRESHOLD,
            "device": str(self._device),
        }

    def _safe_id(self, user_id: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_-]+", "_", user_id)[:48] or "anon"

    def _user_dir(self, user_id: str) -> Path:
        return self.root / self._safe_id(user_id)

    def _profile_path(self, user_id: str) -> Path:
        return self._user_dir(user_id) / "profile.json"

    def _fast_path(self, user_id: str) -> Path:
        return self._user_dir(user_id) / "fast_weights.safetensors"

    def _legacy_path(self, user_id: str) -> Path:
        return self.root / f"{self._safe_id(user_id)}.json"

    # Kept for old callers; new code should use reset().
    def _path(self, user_id: str) -> Path:
        return self._profile_path(user_id)

    def get(self, user_id: str) -> LearnerProfile:
        if user_id in self._cache:
            return self._cache[user_id]
        path = self._profile_path(user_id)
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                profile = LearnerProfile(
                    user_id=user_id,
                    schema_version=int(raw.get("schema_version", SCHEMA_VERSION)),
                    state_revision=int(raw.get("state_revision", 0)),
                    sessions=list(raw.get("sessions") or []),
                    evidence=list(raw.get("evidence") or []),
                    latent_trajectory=list(raw.get("latent_trajectory") or []),
                    checkpoints=list(raw.get("checkpoints") or []),
                    last_state=dict(raw.get("last_state") or {}),
                    last_activity=dict(raw.get("last_activity") or {}),
                    adapter=dict(raw.get("adapter") or {}),
                )
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                profile = LearnerProfile(user_id=user_id)
        else:
            profile = self._migrate_legacy(user_id)
        profile.schema_version = SCHEMA_VERSION
        profile.adapter.setdefault("base_version", self._model.cfg.version)
        profile.adapter.setdefault("online_steps", 0)
        profile.adapter.setdefault("rollback_count", 0)
        profile.adapter.setdefault("representation_steps", 0)
        profile.adapter.setdefault("representation_rollbacks", 0)
        profile.adapter["trained_checkpoint"] = self._trained_checkpoint
        # v2 profiles written before the stabilization schema may contain a
        # valid evidence log but a cached snapshot without revision/graph
        # metadata. Discard only that derived cache; state_snapshot rebuilds
        # it deterministically from the original evidence.
        if profile.last_state and (
            "revision" not in profile.last_state
            or "concept_relations" not in profile.last_state
            or "last_activity" not in profile.last_state
            or any(
                "help_evidence_count" not in belief
                for belief in profile.last_state.get("concept_beliefs", [])
                if isinstance(belief, dict)
            )
        ):
            profile.last_state = {}
        self._cache[user_id] = profile
        return profile

    def _migrate_legacy(self, user_id: str) -> LearnerProfile:
        profile = LearnerProfile(user_id=user_id)
        path = self._legacy_path(user_id)
        if not path.exists():
            return profile
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            profile.sessions = list(raw.get("sessions") or [])
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return profile
        for index, session in enumerate(profile.sessions):
            concepts = session.get("concepts_seen") or []
            evidence = normalise_evidence(
                {
                    "concepts": concepts,
                    "summary": session.get("summary", ""),
                    "outcome": {"correct": 0.25, "partial": 0.5, "incorrect": 0.25},
                    "evidence_strength": 0.1,
                    "independence": 0.2,
                },
                user_id=user_id,
                conversation_id=f"legacy-{index}",
                source="legacy",
            )
            evidence.timestamp = str(session.get("ts") or evidence.timestamp)
            evidence.event_embedding = _hash_embedding(evidence.event_text())
            evidence.embedding_source = "legacy-hash"
            for concept in evidence.concepts:
                concept.embedding = _hash_embedding(
                    f"search_document: {concept.description or concept.name}"
                )
            profile.evidence.append(evidence.to_dict())
        profile.adapter["migrated_from"] = str(path)
        self._save_profile(profile)
        return profile

    def _save_profile(self, profile: LearnerProfile) -> None:
        directory = self._user_dir(profile.user_id)
        directory.mkdir(parents=True, exist_ok=True)
        target = self._profile_path(profile.user_id)
        temp = target.with_suffix(".json.tmp")
        temp.write_text(
            json.dumps(profile.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(temp, target)

    def _load_fast(self, user_id: str) -> dict[str, Tensor]:
        if user_id in self._fast_cache:
            return self._fast_cache[user_id]
        expected = self._model.init_fast_weights(device=self._device)
        path = self._fast_path(user_id)
        if path.exists():
            try:
                loaded = load_file(str(path), device=str(self._device))
                for key, template in expected.items():
                    if key in loaded and loaded[key].shape == template.shape:
                        expected[key] = loaded[key].detach().clone().requires_grad_(True)
            except Exception:
                # A damaged fast checkpoint should not make the learner unusable.
                pass
        self._fast_cache[user_id] = expected
        return expected

    def _save_fast(self, user_id: str, fast: dict[str, Tensor]) -> None:
        directory = self._user_dir(user_id)
        directory.mkdir(parents=True, exist_ok=True)
        target = self._fast_path(user_id)
        temp = target.with_suffix(".safetensors.tmp")
        payload = {key: value.detach().cpu().contiguous() for key, value in fast.items()}
        save_file(payload, str(temp))
        os.replace(temp, target)

    def reset(self, user_id: str) -> None:
        directory = self._user_dir(user_id).resolve()
        root = self.root.resolve()
        if directory.parent != root:
            raise ValueError("refusing to reset outside learner store")
        if directory.exists():
            shutil.rmtree(directory)
        self._cache.pop(user_id, None)
        self._fast_cache.pop(user_id, None)
        # Preserve the legacy source file but write an explicit empty v2
        # profile so a reset does not immediately migrate the old sessions a
        # second time on the next GET.
        fresh = LearnerProfile(user_id=user_id)
        fresh.adapter["reset_at"] = _now()
        self._cache[user_id] = fresh
        self._save_profile(fresh)

    def _ollama(self) -> ollama.Client:
        if self._client is None:
            self._client = ollama.Client(
                host=os.environ.get("OLLAMA_HOST", "http://localhost:11434")
            )
        return self._client

    async def embed(self, text: str, *, query: bool = False) -> tuple[list[float], str]:
        """Embed through Ollama, falling back to a stable hashed vector."""
        prefix = "search_query: " if query else "search_document: "
        payload = prefix + text[:4000]
        loop = asyncio.get_running_loop()
        client = self._ollama()

        def producer() -> list[float]:
            try:
                if hasattr(client, "embed"):
                    response = client.embed(model=self._embed_model, input=payload)
                    vectors = response.get("embeddings", [])
                    return list(vectors[0]) if vectors else []
                response = client.embeddings(model=self._embed_model, prompt=payload)
                return list(response.get("embedding", []))
            except Exception:
                return []

        vector = await loop.run_in_executor(None, producer)
        if len(vector) == self._model.cfg.embedding_dim:
            return vector, self._embed_model
        return _hash_embedding(payload, self._model.cfg.embedding_dim), "hash-fallback"

    async def prepare_evidence(self, evidence: LearningEvidence) -> LearningEvidence:
        if len(evidence.event_embedding) != self._model.cfg.embedding_dim:
            evidence.event_embedding, evidence.embedding_source = await self.embed(
                evidence.event_text()
            )
        for concept in evidence.concepts:
            if len(concept.embedding) != self._model.cfg.embedding_dim:
                concept.embedding, _ = await self.embed(
                    concept.description or concept.name,
                    query=True,
                )
        return evidence

    def _events(self, profile: LearnerProfile) -> list[LearningEvidence]:
        return [LearningEvidence.from_dict(item) for item in profile.evidence]

    def _event_tensors(
        self,
        events: list[LearningEvidence],
    ) -> tuple[Tensor, Tensor, Tensor]:
        if not events:
            event = torch.zeros(1, 1, self._model.cfg.embedding_dim, device=self._device)
            numeric = torch.zeros(1, 1, self._model.cfg.numeric_dim, device=self._device)
            lengths = torch.ones(1, dtype=torch.long, device=self._device)
            return event, numeric, lengths
        trimmed = events[-self._model.cfg.max_events:]
        event = torch.tensor(
            [[item.event_embedding for item in trimmed]],
            dtype=torch.float32,
            device=self._device,
        )
        numeric = torch.tensor(
            [[item.numeric_features() for item in trimmed]],
            dtype=torch.float32,
            device=self._device,
        )
        lengths = torch.tensor([len(trimmed)], dtype=torch.long, device=self._device)
        return event, numeric, lengths

    def _adaptation_batch(
        self,
        events: list[LearningEvidence],
        target_indices: list[int],
    ) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor, Tensor]:
        histories: list[list[LearningEvidence]] = []
        targets: list[LearningEvidence] = []
        for index in target_indices:
            histories.append(events[max(0, index - self._model.cfg.max_events):index])
            targets.append(events[index])
        max_time = max(1, max((len(history) for history in histories), default=0))
        batch = len(targets)
        event_tensor = torch.zeros(
            batch,
            max_time,
            self._model.cfg.embedding_dim,
            device=self._device,
        )
        numeric_tensor = torch.zeros(
            batch,
            max_time,
            self._model.cfg.numeric_dim,
            device=self._device,
        )
        lengths = torch.ones(batch, dtype=torch.long, device=self._device)
        concepts = torch.zeros(
            batch,
            self._model.cfg.embedding_dim,
            device=self._device,
        )
        labels = torch.zeros(batch, device=self._device)
        weights = torch.zeros(batch, device=self._device)
        for row, (history, target) in enumerate(zip(histories, targets)):
            trimmed = history[-max_time:]
            if trimmed:
                event_tensor[row, :len(trimmed)] = torch.tensor(
                    [item.event_embedding for item in trimmed],
                    dtype=torch.float32,
                    device=self._device,
                )
                numeric_tensor[row, :len(trimmed)] = torch.tensor(
                    [item.numeric_features() for item in trimmed],
                    dtype=torch.float32,
                    device=self._device,
                )
                lengths[row] = len(trimmed)
            concepts[row] = torch.tensor(
                target.concepts[0].embedding,
                dtype=torch.float32,
                device=self._device,
            )
            labels[row] = target.outcome.soft_score
            weights[row] = target.evidence_strength * max(0.25, target.independence)
        return event_tensor, numeric_tensor, lengths, concepts, labels, weights

    def _fast_loss(
        self,
        batch: tuple[Tensor, Tensor, Tensor, Tensor, Tensor, Tensor],
        fast: dict[str, Tensor],
        *,
        anchor: float,
    ) -> Tensor:
        events, numeric, lengths, concepts, labels, weights = batch
        prediction, _, _, _ = self._model(
            events,
            numeric,
            concepts,
            lengths=lengths,
            fast=fast,
            samples=1,
        )
        prediction = prediction.squeeze(1).clamp(1e-5, 1 - 1e-5)
        loss = F.binary_cross_entropy(prediction, labels, reduction="none")
        weighted = (loss * weights).sum() / weights.sum().clamp_min(1e-6)
        if anchor:
            weighted = weighted + anchor * sum(
                tensor.square().mean() for tensor in fast.values()
            )
        return weighted

    @staticmethod
    def _representation_fast(fast: dict[str, Tensor]) -> dict[str, Tensor]:
        return {key: value for key, value in fast.items() if key.startswith("blocks.")}

    def _representation_batch(
        self,
        events: list[LearningEvidence],
        *,
        seed: int,
    ) -> tuple[Tensor, Tensor, Tensor, Tensor, Tensor]:
        """Build deterministic clean/noisy sequence views for consistency TTA."""
        if not events:
            raise ValueError("representation adaptation requires at least one event")
        endpoints = list(range(max(1, len(events) - 7), len(events) + 1))
        histories = [events[max(0, end - self._model.cfg.max_events):end] for end in endpoints]
        max_time = max(len(history) for history in histories)
        batch = len(histories)
        clean = torch.zeros(
            batch, max_time, self._model.cfg.embedding_dim, device=self._device
        )
        numeric = torch.zeros(
            batch, max_time, self._model.cfg.numeric_dim, device=self._device
        )
        lengths = torch.zeros(batch, dtype=torch.long, device=self._device)
        for row, history in enumerate(histories):
            clean[row, :len(history)] = torch.tensor(
                [item.event_embedding for item in history],
                dtype=torch.float32,
                device=self._device,
            )
            numeric[row, :len(history)] = torch.tensor(
                [item.numeric_features() for item in history],
                dtype=torch.float32,
                device=self._device,
            )
            lengths[row] = len(history)

        generator = torch.Generator(device=self._device)
        generator.manual_seed(seed)

        def noisy_view() -> Tensor:
            keep = (
                torch.rand(clean.shape, generator=generator, device=self._device) > 0.08
            ).to(clean.dtype)
            noise = torch.randn(
                clean.shape, generator=generator, device=self._device
            ) * 0.01
            return clean * keep + noise

        return clean, noisy_view(), noisy_view(), numeric, lengths

    def _representation_consistency_loss(
        self,
        batch: tuple[Tensor, Tensor, Tensor, Tensor, Tensor],
        fast: dict[str, Tensor],
        target_mu: Tensor,
        target_logvar: Tensor,
        *,
        anchor: float,
    ) -> Tensor:
        _, view_a, view_b, numeric, lengths = batch
        mu_a, logvar_a = self._model.encode(
            view_a, numeric, lengths=lengths, fast=fast
        )
        mu_b, logvar_b = self._model.encode(
            view_b, numeric, lengths=lengths, fast=fast
        )
        cosine = (
            2.0
            - F.cosine_similarity(mu_a, target_mu, dim=-1).mean()
            - F.cosine_similarity(mu_b, target_mu, dim=-1).mean()
        )
        posterior = 0.05 * (
            F.mse_loss(logvar_a, target_logvar)
            + F.mse_loss(logvar_b, target_logvar)
        )
        loss = cosine + posterior
        if anchor:
            representation = self._representation_fast(fast)
            loss = loss + anchor * sum(
                tensor.square().mean() for tensor in representation.values()
            )
        return loss

    def adapt_representation(self, profile: LearnerProfile) -> dict:
        """One guarded self-supervised LoRA step for every new interaction."""
        if not self._trained_checkpoint:
            return {
                "adapted": False, "reason": "untrained-base", "steps": 0,
                "rolled_back": False,
            }
        events = self._events(profile)
        if not events:
            return {
                "adapted": False, "reason": "no-events", "steps": 0,
                "rolled_back": False,
            }
        seed_text = profile.user_id + "|" + events[-1].evidence_id
        seed = int(hashlib.sha256(seed_text.encode()).hexdigest()[:8], 16)
        batch = self._representation_batch(events, seed=seed)
        clean, _, _, numeric, lengths = batch
        fast = self._load_fast(profile.user_id)
        representation = self._representation_fast(fast)
        before_state = {
            key: value.detach().clone().requires_grad_(True)
            for key, value in representation.items()
        }
        with torch.no_grad():
            target_mu, target_logvar = self._model.encode(
                clean, numeric, lengths=lengths, fast=fast
            )
            target_mu = target_mu.detach()
            target_logvar = target_logvar.detach()
            before_loss = float(
                self._representation_consistency_loss(
                    batch, fast, target_mu, target_logvar, anchor=0.0
                ).item()
            )

        optimiser = torch.optim.AdamW(
            list(representation.values()), lr=2e-4, weight_decay=0.0
        )
        optimiser.zero_grad(set_to_none=True)
        loss = self._representation_consistency_loss(
            batch, fast, target_mu, target_logvar, anchor=1e-4
        )
        loss.backward()
        torch.nn.utils.clip_grad_norm_(list(representation.values()), max_norm=0.5)
        optimiser.step()

        with torch.no_grad():
            after_loss = float(
                self._representation_consistency_loss(
                    batch, fast, target_mu, target_logvar, anchor=0.0
                ).item()
            )
        if not math.isfinite(after_loss) or after_loss > before_loss * 1.05:
            for key, value in before_state.items():
                fast[key] = value
            profile.adapter["representation_rollbacks"] = int(
                profile.adapter.get("representation_rollbacks", 0)
            ) + 1
            return {
                "adapted": False,
                "rolled_back": True,
                "steps": 0,
                "before_loss": before_loss,
                "after_loss": after_loss,
            }

        profile.adapter["representation_steps"] = int(
            profile.adapter.get("representation_steps", 0)
        ) + 1
        self._save_fast(profile.user_id, fast)
        return {
            "adapted": True,
            "rolled_back": False,
            "steps": 1,
            "before_loss": before_loss,
            "after_loss": after_loss,
        }

    def adapt_fast_weights(self, profile: LearnerProfile) -> dict:
        if not self._trained_checkpoint:
            return {
                "adapted": False, "reason": "untrained-base", "steps": 0,
                "rolled_back": False,
            }
        events = self._events(profile)
        strong = [i for i, event in enumerate(events) if event.adapts_fast_weights]
        if not strong:
            return {
                "adapted": False, "reason": "no-strong-evidence", "steps": 0,
                "rolled_back": False,
            }
        recent = strong[-8:]
        replay_pool = strong[:-8]
        # Deterministic replay makes tests and paper runs reproducible.
        replay = replay_pool[-8:]
        target_indices = sorted(set(recent + replay))
        batch = self._adaptation_batch(events, target_indices)
        guard_batch = self._adaptation_batch(events, replay or recent)
        fast = self._load_fast(profile.user_id)
        before_state = clone_fast_weights(fast)
        with torch.no_grad():
            before_loss = float(self._fast_loss(guard_batch, fast, anchor=0.0).item())

        optimiser = torch.optim.AdamW(list(fast.values()), lr=1e-3, weight_decay=0.0)
        for _ in range(3):
            optimiser.zero_grad(set_to_none=True)
            loss = self._fast_loss(batch, fast, anchor=1e-4)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(list(fast.values()), max_norm=1.0)
            optimiser.step()

        with torch.no_grad():
            after_loss = float(self._fast_loss(guard_batch, fast, anchor=0.0).item())
        if not math.isfinite(after_loss) or after_loss > before_loss * 1.05:
            self._fast_cache[profile.user_id] = before_state
            profile.adapter["rollback_count"] = int(
                profile.adapter.get("rollback_count", 0)
            ) + 1
            return {
                "adapted": False,
                "rolled_back": True,
                "steps": 0,
                "before_loss": before_loss,
                "after_loss": after_loss,
            }

        profile.adapter["online_steps"] = int(profile.adapter.get("online_steps", 0)) + 3
        profile.adapter["last_before_loss"] = round(before_loss, 6)
        profile.adapter["last_after_loss"] = round(after_loss, 6)
        self._save_fast(profile.user_id, fast)
        return {
            "adapted": True,
            "rolled_back": False,
            "steps": 3,
            "before_loss": before_loss,
            "after_loss": after_loss,
        }

    def _concept_names(self, events: Iterable[LearningEvidence]) -> list[str]:
        score: dict[str, float] = {}
        for position, event in enumerate(events):
            recency = 1.0 + position / 1000.0
            for concept in event.concepts:
                score[concept.name] = score.get(concept.name, 0.0) + (
                    event.evidence_strength * concept.confidence * recency
                )
        return [name for name, _ in sorted(score.items(), key=lambda item: -item[1])[:12]]

    @staticmethod
    def _concept_relations(
        events: list[LearningEvidence],
        names: list[str],
        vectors: dict[str, list[float]],
    ) -> list[dict]:
        cooccurrence: dict[tuple[str, str], int] = {}
        allowed = set(names)
        for event in events:
            present = sorted({c.name for c in event.concepts if c.name in allowed})
            for left_index, left in enumerate(present):
                for right in present[left_index + 1:]:
                    cooccurrence[(left, right)] = cooccurrence.get((left, right), 0) + 1

        candidates: list[dict] = []
        for left_index, left in enumerate(names):
            left_vector = vectors.get(left) or []
            for right in names[left_index + 1:]:
                right_vector = vectors.get(right) or []
                semantic = 0.0
                if left_vector and len(left_vector) == len(right_vector):
                    semantic = max(
                        0.0,
                        sum(a * b for a, b in zip(left_vector, right_vector)),
                    )
                pair = tuple(sorted((left, right)))
                together = cooccurrence.get(pair, 0)
                co_strength = min(1.0, together / 3.0)
                strength = min(1.0, max(semantic, co_strength))
                if strength < 0.12 and together == 0:
                    continue
                kind = "mixed" if semantic >= 0.12 and together else (
                    "co-occurrence" if together else "semantic"
                )
                candidates.append({
                    "source": left,
                    "target": right,
                    "strength": round(strength, 4),
                    "kind": kind,
                })

        candidates.sort(key=lambda item: item["strength"], reverse=True)
        degree = {name: 0 for name in names}
        selected: list[dict] = []
        for relation in candidates:
            source, target = relation["source"], relation["target"]
            if degree[source] >= 3 or degree[target] >= 3:
                continue
            selected.append(relation)
            degree[source] += 1
            degree[target] += 1
            if len(selected) >= 18:
                break
        return selected

    @staticmethod
    def _bayesian_latent_point(events: list[LearningEvidence]) -> list[float]:
        """Project frozen event embeddings without evaluating an untrained net."""
        totals = [0.0, 0.0, 0.0]
        total_weight = 0.0
        recent = events[-64:]
        for index, event in enumerate(recent):
            vector = event.event_embedding
            if not vector:
                continue
            recency = 0.5 + 0.5 * ((index + 1) / len(recent))
            weight = max(0.05, event.evidence_strength) * recency
            total_weight += weight
            for axis in range(3):
                projection = sum(vector[axis::3]) / math.sqrt(
                    max(1, len(vector[axis::3]))
                )
                totals[axis] += weight * projection
        if not total_weight:
            return [0.0, 0.0, 0.0]
        return [round(math.tanh(value / total_weight), 5) for value in totals]

    def state_snapshot(self, profile: LearnerProfile) -> dict:
        events = self._events(profile)
        concept_names = self._concept_names(events)
        previous_beliefs = {
            belief.get("name"): belief
            for belief in profile.last_state.get("concept_beliefs", [])
            if isinstance(belief, dict) and belief.get("name")
        }
        fast: dict[str, Tensor] | None = None
        mu: Tensor | None = None
        logvar: Tensor | None = None
        if self._trained_checkpoint:
            fast = self._load_fast(profile.user_id)
            event_tensor, numeric, lengths = self._event_tensors(events)
            with torch.no_grad():
                mu, logvar = self._model.encode(
                    event_tensor,
                    numeric,
                    lengths=lengths,
                    fast=fast,
                )

        beliefs: list[dict] = []
        concept_vector_map: dict[str, list[float]] = {}
        if concept_names:
            concept_vectors: list[list[float]] = []
            for name in concept_names:
                vector: list[float] = []
                for event in reversed(events):
                    found = next((c for c in event.concepts if c.name == name), None)
                    if found and len(found.embedding) == self._model.cfg.embedding_dim:
                        vector = found.embedding
                        break
                concept_vectors.append(vector or _hash_embedding(f"search_query: {name}"))
                concept_vector_map[name] = concept_vectors[-1]
            queries = torch.tensor(
                [concept_vectors], dtype=torch.float32, device=self._device
            )
            neural_mean: Tensor | None = None
            neural_std: Tensor | None = None
            if self._trained_checkpoint and mu is not None and logvar is not None:
                seed_text = profile.user_id + "|" + "|".join(
                    event.evidence_id for event in events[-16:]
                )
                sample_seed = int(hashlib.sha256(seed_text.encode()).hexdigest()[:8], 16)
                cuda_devices = [self._device.index or 0] if self._device.type == "cuda" else []
                with torch.no_grad(), torch.random.fork_rng(devices=cuda_devices):
                    torch.manual_seed(sample_seed)
                    neural_mean, neural_std = self._model.query(
                        mu,
                        logvar,
                        queries,
                        fast=fast,
                        samples=16,
                    )
            neural_weight = 0.5 if self._trained_checkpoint else 0.0
            for column, name in enumerate(concept_names):
                relevant = [
                    event
                    for event in events
                    if any(concept.name == name for concept in event.concepts)
                ]
                assessed = [event for event in relevant if event.source == "checkpoint_answer"]
                strong = [
                    event for event in assessed
                    if event.evidence_strength >= EVIDENCE_THRESHOLD
                ]
                help_events = [event for event in relevant if event.source == "help_request"]
                alpha = 1.0
                beta = 1.0
                weighted_scores: list[float] = []
                misconception = ""
                for event in assessed:
                    weight = event.evidence_strength * max(0.25, event.independence)
                    score = event.outcome.soft_score
                    alpha += weight * score
                    beta += weight * (1.0 - score)
                    weighted_scores.append(score)
                    if event.misconception and event.evidence_strength >= EVIDENCE_THRESHOLD:
                        misconception = event.misconception
                bayes_mean = alpha / (alpha + beta)
                bayes_std = math.sqrt(
                    alpha * beta
                    / (((alpha + beta) ** 2) * (alpha + beta + 1.0))
                )
                model_mean = (
                    float(neural_mean[0, column].item())
                    if neural_mean is not None else bayes_mean
                )
                model_std = (
                    float(neural_std[0, column].item())
                    if neural_std is not None else bayes_std
                )
                concept_neural_weight = neural_weight if assessed else 0.0
                mastery = (
                    (1 - concept_neural_weight) * bayes_mean
                    + concept_neural_weight * model_mean
                )
                uncertainty = min(
                    0.5,
                    math.sqrt(
                        ((1 - concept_neural_weight) * bayes_std) ** 2
                        + (concept_neural_weight * model_std) ** 2
                    ),
                )
                trend = 0.0
                if len(weighted_scores) >= 2:
                    midpoint = max(1, len(weighted_scores) // 2)
                    trend = (
                        sum(weighted_scores[midpoint:]) / len(weighted_scores[midpoint:])
                        - sum(weighted_scores[:midpoint]) / midpoint
                    )
                previous = previous_beliefs.get(name, {})
                # A help request may reshape the latent representation and its
                # uncertainty, but must never masquerade as new mastery proof.
                if (
                    relevant
                    and relevant[-1].source == "help_request"
                    and previous
                ):
                    mastery = float(previous.get("mastery_mean", mastery))
                beliefs.append({
                    "name": name,
                    "mastery_mean": round(mastery, 4),
                    "mastery_std": round(uncertainty, 4),
                    "credible_low": round(max(0.0, mastery - 1.96 * uncertainty), 4),
                    "credible_high": round(min(1.0, mastery + 1.96 * uncertainty), 4),
                    "evidence_count": len(relevant),
                    "help_evidence_count": len(help_events),
                    "strong_evidence_count": len(strong),
                    "last_evidence_at": relevant[-1].timestamp if relevant else "",
                    "mastery_delta": round(
                        mastery - float(previous.get("mastery_mean", mastery)), 4
                    ),
                    "uncertainty_delta": round(
                        uncertainty - float(previous.get("mastery_std", uncertainty)), 4
                    ),
                    "trend": round(trend, 4),
                    "misconception": misconception,
                })

        point = (
            [round(math.tanh(float(mu[0, i].item())), 5) for i in range(3)]
            if mu is not None
            else self._bayesian_latent_point(events)
        )
        trajectory_entry = {
            "ts": _now(),
            "x": point[0],
            "y": point[1],
            "z": point[2],
            "observations": len(events),
        }
        if not profile.latent_trajectory or any(
            abs(profile.latent_trajectory[-1].get(axis, 0.0) - trajectory_entry[axis]) > 1e-6
            for axis in ("x", "y", "z")
        ):
            profile.latent_trajectory.append(trajectory_entry)
            profile.latent_trajectory = profile.latent_trajectory[-100:]

        state = {
            "schema_version": SCHEMA_VERSION,
            "revision": profile.state_revision,
            "updated_at": _now(),
            "observations": len(events),
            "concept_beliefs": beliefs,
            "latent_point": trajectory_entry,
            "latent_trajectory": profile.latent_trajectory,
            "concept_relations": self._concept_relations(
                events, concept_names, concept_vector_map
            ),
            "last_activity": profile.last_activity,
            "profile_text": self._profile_text(beliefs),
            "adapter": {
                **profile.adapter,
                "base_version": self._model.cfg.version,
                "parameter_count": self._model.parameter_count,
                "trained_checkpoint": self._trained_checkpoint,
            },
        }
        profile.last_state = state
        return state

    @staticmethod
    def _profile_text(beliefs: list[dict]) -> str:
        if not beliefs:
            return "New learner: no reliable knowledge evidence yet. Begin with a short diagnostic explanation."
        likely = [b["name"] for b in beliefs if b["mastery_mean"] >= 0.7 and b["mastery_std"] < 0.25]
        support = [b["name"] for b in beliefs if b["mastery_mean"] <= 0.42]
        uncertain = [b["name"] for b in beliefs if b["mastery_std"] >= 0.25]
        misconceptions = [
            f"{b['name']}: {b['misconception']}"
            for b in beliefs
            if b.get("misconception")
        ]
        parts: list[str] = []
        if likely:
            parts.append("likely understands " + ", ".join(likely[:4]))
        if support:
            parts.append("needs support with " + ", ".join(support[:4]))
        if uncertain:
            parts.append("insufficient evidence for " + ", ".join(uncertain[:4]))
        if misconceptions:
            parts.append("observed misconception: " + misconceptions[-1])
        pace = "Use a concrete worked example and one short check."
        if likely and not support:
            pace = "Skip mastered basics and ask a transfer question."
        return "; ".join(parts) + ". " + pace

    def system_prompt_prefix(self, user_id: str) -> str:
        profile = self.get(user_id)
        if not profile.evidence:
            return ""
        state = profile.last_state or self.state_snapshot(profile)
        return (
            "# Probabilistic learner state\n\n"
            + state.get("profile_text", "")
            + "\nTreat low-confidence beliefs as hypotheses, not facts. "
            "Do not reveal numeric mastery scores to the learner.\n\n---\n\n"
        )

    async def record_evidence(
        self,
        evidence: LearningEvidence,
        *,
        allow_adaptation: bool,
    ) -> tuple[dict, dict]:
        profile = self.get(evidence.user_id)
        evidence = await self.prepare_evidence(evidence)
        profile.evidence.append(evidence.to_dict())
        profile.evidence = profile.evidence[-500:]
        representation = self.adapt_representation(profile)
        mastery = {"adapted": False, "reason": "not-authorised", "steps": 0}
        if allow_adaptation and evidence.adapts_fast_weights:
            mastery = self.adapt_fast_weights(profile)
        adaptation = {
            "adapted": bool(representation.get("adapted") or mastery.get("adapted")),
            "steps": int(representation.get("steps", 0)) + int(mastery.get("steps", 0)),
            "rolled_back": bool(
                representation.get("rolled_back") or mastery.get("rolled_back")
            ),
            "representation": representation,
            "mastery": mastery,
        }
        profile.state_revision += 1
        profile.last_activity = {
            "evidence_id": evidence.evidence_id,
            "source": evidence.source,
            "timestamp": evidence.timestamp,
            "concepts": [concept.name for concept in evidence.concepts],
            "representation_adapted": bool(representation.get("adapted")),
            "mastery_adapted": bool(mastery.get("adapted")),
        }
        state = self.state_snapshot(profile)
        self._save_profile(profile)
        return state, adaptation

    def save_checkpoint(self, user_id: str, checkpoint: dict) -> dict:
        profile = self.get(user_id)
        item = {
            "checkpoint_id": str(checkpoint.get("checkpoint_id") or (
                "cp_" + hashlib.sha256(
                    f"{user_id}|{_now()}|{random.random()}".encode("utf-8")
                ).hexdigest()[:14]
            )),
            "conversation_id": str(checkpoint.get("conversation_id", "default")),
            "question": _clean_text(checkpoint.get("question"), 500),
            "concepts": [
                _clean_concept_name(c) for c in checkpoint.get("concepts", [])
                if _clean_concept_name(c)
            ][:6],
            "rubric": _clean_text(checkpoint.get("rubric"), 1000),
            "difficulty": _clean_text(checkpoint.get("difficulty"), 40) or "introductory",
            "created_at": _now(),
        }
        profile.checkpoints.append(item)
        profile.checkpoints = profile.checkpoints[-50:]
        self._save_profile(profile)
        return item

    def get_checkpoint(self, user_id: str, checkpoint_id: str) -> dict | None:
        profile = self.get(user_id)
        return next(
            (item for item in reversed(profile.checkpoints) if item.get("checkpoint_id") == checkpoint_id),
            None,
        )

    async def extract_concepts(self, lesson_text: str, teacher_model: str) -> dict:
        loop = asyncio.get_running_loop()
        client = self._ollama()

        def producer() -> str:
            try:
                response = client.generate(
                    model=teacher_model,
                    prompt=f"Lesson:\n{lesson_text}\n\nReturn JSON.",
                    system=EXTRACT_SYSTEM_PROMPT,
                    stream=False,
                    options={"temperature": 0.1, "num_predict": 256},
                )
                return str(response.get("response", ""))
            except Exception:
                return ""

        raw = await loop.run_in_executor(None, producer)
        return _parse_extract_json(raw)

    async def update(
        self,
        user_id: str,
        lesson_text: str,
        primitives_count: int,
        teacher_model: str,
        conversation_id: str = "default",
    ) -> SessionRecord:
        """Compatibility hook: record a lesson as weak help-request evidence."""
        extract = await self.extract_concepts(lesson_text, teacher_model)
        evidence = normalise_evidence(
            {
                "concepts": extract.get("concepts_seen", []),
                "summary": extract.get("summary", ""),
                "outcome": {"correct": 0.2, "partial": 0.5, "incorrect": 0.3},
                "evidence_strength": 0.15,
                "independence": 0.2,
                "task_text": lesson_text[:1000],
            },
            user_id=user_id,
            conversation_id=conversation_id,
            source="help_request",
        )
        state, _ = await self.record_evidence(evidence, allow_adaptation=False)
        vector, _ = await self.embed(lesson_text)
        beliefs = {b["name"]: b for b in state.get("concept_beliefs", [])}
        concepts = [c.name for c in evidence.concepts]
        record = SessionRecord(
            ts=_now(),
            topic=str(extract.get("topic", "")),
            primitives_count=primitives_count,
            concepts_seen=concepts,
            mastered=[c for c in concepts if beliefs.get(c, {}).get("mastery_mean", 0.5) >= 0.7],
            struggling=[c for c in concepts if beliefs.get(c, {}).get("mastery_mean", 0.5) <= 0.42],
            summary=str(extract.get("summary", "")),
            embedding=vector,
        )
        profile = self.get(user_id)
        profile.sessions.append(record.__dict__)
        self._save_profile(profile)
        return record


def _parse_extract_json(raw: str) -> dict:
    fallback = {"topic": "", "concepts_seen": [], "summary": ""}
    if not raw:
        return fallback
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    candidates = [cleaned]
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        candidates.append(cleaned[start:end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if not isinstance(value, dict):
                continue
            concepts = value.get("concepts_seen") or value.get("concepts") or []
            if isinstance(concepts, str):
                concepts = [concepts]
            return {
                "topic": _clean_text(value.get("topic"), 80),
                "concepts_seen": [
                    name for name in (_clean_concept_name(c) for c in concepts) if name
                ][:8],
                "summary": _clean_text(value.get("summary"), 500),
            }
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return fallback
