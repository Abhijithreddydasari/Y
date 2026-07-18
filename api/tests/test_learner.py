from __future__ import annotations

import json
import asyncio
from pathlib import Path

import pytest
import torch

from learner import LearnerStore, normalise_evidence
from learner_adapter import AdapterConfig, LearnerAdapterModel


def tiny_config() -> AdapterConfig:
    return AdapterConfig(
        embedding_dim=32,
        numeric_dim=8,
        model_dim=32,
        latent_dim=16,
        ff_dim=64,
        heads=4,
        layers=4,
        max_events=16,
        lora_rank=2,
    )


def ready_evidence(cfg: AdapterConfig, *, strength: float = 0.9):
    evidence = normalise_evidence(
        {
            "concepts": [{"name": "fraction addition", "confidence": 0.9}],
            "outcome": {"correct": 0.8, "partial": 0.15, "incorrect": 0.05},
            "independence": 0.95,
            "evidence_strength": strength,
            "response_summary": "Added unlike fractions after finding a denominator.",
        },
        user_id="learner-a",
        conversation_id="conversation-a",
        source="checkpoint_answer",
    )
    evidence.event_embedding = [0.05] * cfg.embedding_dim
    evidence.embedding_source = "test"
    for concept in evidence.concepts:
        concept.embedding = [0.1] * cfg.embedding_dim
    return evidence


def test_probability_normalisation_and_evidence_gate() -> None:
    evidence = normalise_evidence(
        {
            "concepts": ["Quadratic Formula", "Quadratic Formula"],
            "outcome": {"correct": 4, "partial": 1, "incorrect": 0},
            "evidence_strength": 0.8,
        },
        user_id="u",
        conversation_id="c",
        source="checkpoint_answer",
    )
    assert len(evidence.concepts) == 1
    assert evidence.concepts[0].name == "quadratic-formula"
    assert evidence.outcome.correct + evidence.outcome.partial + evidence.outcome.incorrect == pytest.approx(1)
    assert evidence.adapts_fast_weights


def test_variational_shapes_and_uncertainty() -> None:
    cfg = tiny_config()
    model = LearnerAdapterModel(cfg)
    events = torch.zeros(2, 4, cfg.embedding_dim)
    numeric = torch.zeros(2, 4, cfg.numeric_dim)
    concepts = torch.zeros(2, 3, cfg.embedding_dim)
    mu, logvar = model.encode(events, numeric, lengths=torch.tensor([4, 2]))
    mean, uncertainty = model.query(mu, logvar, concepts, samples=16)
    assert mu.shape == (2, cfg.latent_dim)
    assert logvar.shape == (2, cfg.latent_dim)
    assert mean.shape == uncertainty.shape == (2, 3)
    assert torch.all((mean >= 0) & (mean <= 1))
    assert torch.all(uncertainty >= 0)


def test_guarded_update_save_load_and_reset(tmp_path: Path) -> None:
    cfg = tiny_config()
    store = LearnerStore(
        root=tmp_path,
        adapter_checkpoint=tmp_path / "missing.safetensors",
        adapter_config=cfg,
    )
    weak = ready_evidence(cfg, strength=0.4)
    _, weak_update = asyncio.run(store.record_evidence(weak, allow_adaptation=True))
    assert weak_update["adapted"] is False
    assert not (tmp_path / "learner-a" / "fast_weights.safetensors").exists()

    strong = ready_evidence(cfg)
    state, update = asyncio.run(store.record_evidence(strong, allow_adaptation=True))
    assert update["adapted"] is True
    assert state["concept_beliefs"][0]["evidence_count"] == 2
    assert (tmp_path / "learner-a" / "profile.json").exists()
    assert (tmp_path / "learner-a" / "fast_weights.safetensors").exists()

    reloaded = LearnerStore(
        root=tmp_path,
        adapter_checkpoint=tmp_path / "missing.safetensors",
        adapter_config=cfg,
    ).get("learner-a")
    assert reloaded.adapter["online_steps"] == 3
    assert len(reloaded.evidence) == 2

    store.reset("learner-a")
    assert (tmp_path / "learner-a" / "profile.json").exists()
    assert not (tmp_path / "learner-a" / "fast_weights.safetensors").exists()
    assert store.get("learner-a").evidence == []


def test_rollback_restores_fast_weights(tmp_path: Path) -> None:
    cfg = tiny_config()
    store = LearnerStore(
        root=tmp_path,
        adapter_checkpoint=tmp_path / "missing.safetensors",
        adapter_config=cfg,
    )
    profile = store.get("learner-a")
    evidence = ready_evidence(cfg)
    profile.evidence.append(evidence.to_dict())
    original_loss = store._fast_loss
    calls = 0

    def worsening_loss(*args, **kwargs):
        nonlocal calls
        calls += 1
        loss = original_loss(*args, **kwargs)
        return loss * 2 if calls >= 5 else loss

    store._fast_loss = worsening_loss  # type: ignore[method-assign]
    result = store.adapt_fast_weights(profile)
    assert result["rolled_back"] is True
    assert profile.adapter["rollback_count"] == 1


def test_legacy_migration_preserves_source(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy-user.json"
    legacy.write_text(json.dumps({"sessions": [{
        "ts": "2026-01-01T00:00:00+00:00",
        "concepts_seen": ["momentum"],
        "summary": "A help session about momentum.",
    }]}), encoding="utf-8")
    store = LearnerStore(
        root=tmp_path,
        adapter_checkpoint=tmp_path / "missing.safetensors",
        adapter_config=tiny_config(),
    )
    profile = store.get("legacy-user")
    assert profile.schema_version == 2
    assert profile.evidence[0]["source"] == "legacy"
    assert profile.evidence[0]["evidence_strength"] < 0.65
    assert legacy.exists()
    store.reset("legacy-user")
    assert legacy.exists()
    assert store.get("legacy-user").evidence == []
