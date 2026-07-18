from __future__ import annotations

import json

from fastapi.testclient import TestClient

import main
from learner import LearnerStore
from learner_adapter import AdapterConfig


class FakeTeacher:
    host = "mock://teacher"
    model = "mock-teacher"

    def ping(self) -> bool:
        return True

    def warmup(self) -> None:
        return None

    async def stream_lesson(self, png_bytes: bytes, system_prefix: str = "", safety_identifier: str = ""):
        assert safety_identifier.startswith("y_")
        yield '[title: "Fractions"] [text: "Find a common denominator."]'

    async def educator_notes(self, png_bytes: bytes, lesson_text: str = "") -> dict:
        return {"misconceptions": [], "follow_ups": [], "prereqs": [], "difficulty": "introductory"}

    async def extract_evidence(self, png_bytes: bytes, checkpoint: dict, safety_identifier: str = "") -> dict:
        return {
            "concepts": [{"name": "fraction addition", "description": "add unlike fractions"}],
            "outcome": {"correct": 0.85, "partial": 0.1, "incorrect": 0.05},
            "independence": 0.95,
            "evidence_strength": 0.95,
            "response_summary": "Correct common-denominator method.",
        }

    async def generate_checkpoint(self, lesson_text: str, learner_state: dict, conversation_id: str, safety_identifier: str = "") -> dict:
        return {
            "conversation_id": conversation_id,
            "question": "What is one half plus one third? Show why.",
            "concepts": ["fraction addition"],
            "rubric": "Answer five sixths using a common denominator.",
            "difficulty": "introductory",
        }

    async def stream_assessment_feedback(self, png_bytes: bytes, checkpoint: dict, evidence: dict, system_prefix: str = "", safety_identifier: str = ""):
        yield '[text: "Correct. Both fractions were converted to sixths."]'


def event_names(body: str) -> list[str]:
    return [line.split(":", 1)[1].strip() for line in body.splitlines() if line.startswith("event:")]


def test_lesson_and_assessment_sse_contract(tmp_path, monkeypatch) -> None:
    cfg = AdapterConfig(
        embedding_dim=32, numeric_dim=8, model_dim=32, latent_dim=16,
        ff_dim=64, heads=4, layers=4, max_events=16, lora_rank=2,
    )
    store = LearnerStore(
        root=tmp_path,
        adapter_checkpoint=tmp_path / "missing.safetensors",
        adapter_config=cfg,
    )

    async def embed(_text: str, *, query: bool = False):
        return ([0.05] * cfg.embedding_dim, "test")

    async def extract(_lesson: str, _model: str):
        return {"topic": "fractions", "concepts_seen": ["fraction addition"], "summary": "Adding fractions."}

    store.embed = embed  # type: ignore[method-assign]
    store.extract_concepts = extract  # type: ignore[method-assign]
    teacher = FakeTeacher()
    monkeypatch.setattr(main, "get_teacher", lambda choice="edge": teacher)
    monkeypatch.setattr(main, "_learner_store", store)

    with TestClient(main.app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["learner_adapter"]["parameter_count"] > 0
        assert "speech" in health.json()
        lesson = client.post(
            "/lesson",
            files={"image": ("board.png", b"png", "image/png")},
            data={"user_id": "test-user", "conversation_id": "conv-1", "model_choice": "openai"},
        )
        assert lesson.status_code == 200
        lesson_events = event_names(lesson.text)
        assert lesson_events[-4:] == ["learner_update", "learner_state", "checkpoint", "done"]
        checkpoint = store.get("test-user").checkpoints[-1]

        assessment = client.post(
            "/assess",
            files={"image": ("answer.png", b"png", "image/png")},
            data={
                "user_id": "test-user",
                "conversation_id": "conv-1",
                "checkpoint_id": checkpoint["checkpoint_id"],
                "model_choice": "openai",
            },
        )
        assert assessment.status_code == 200
        assessment_events = event_names(assessment.text)
        assert assessment_events[0] == "evidence"
        assert assessment_events[-3:] == ["learner_state", "checkpoint", "done"]
        profile = client.get("/learner/test-user").json()
        assert profile["schema_version"] == 2
        assert profile["online_step_count"] == 3
        assert profile["concept_beliefs"]


def test_assess_rejects_unknown_checkpoint(monkeypatch) -> None:
    monkeypatch.setattr(main, "get_teacher", lambda choice="edge": FakeTeacher())
    with TestClient(main.app) as client:
        response = client.post(
            "/assess",
            files={"image": ("answer.png", b"png", "image/png")},
            data={"user_id": "missing", "conversation_id": "c", "checkpoint_id": "not-there"},
        )
    assert response.status_code == 404
