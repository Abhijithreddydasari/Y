from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

import main
from learner import LearnerStore
from learner_adapter import AdapterConfig


class ChatTeacher:
    host = "mock://chat"
    model = "mock-chat"

    def ping(self) -> bool:
        return True

    def warmup(self) -> None:
        return None

    async def stream_chat(self, messages, learner_context="", lesson_context="", safety_identifier=""):
        assert messages[-1] == {"role": "user", "content": "Why do we add C?"}
        assert "integration" in lesson_context
        assert safety_identifier.startswith("y_")
        yield "Because the derivative of "
        yield "$C$ is zero."


def small_store(tmp_path: Path) -> LearnerStore:
    return LearnerStore(
        root=tmp_path,
        adapter_checkpoint=tmp_path / "missing.safetensors",
        adapter_config=AdapterConfig(
            embedding_dim=32, numeric_dim=8, model_dim=32, latent_dim=16,
            ff_dim=64, heads=4, layers=4, max_events=16, lora_rank=2,
        ),
    )


def test_chat_streams_markdown_deltas(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "get_teacher", lambda choice="edge": ChatTeacher())
    monkeypatch.setattr(main, "_learner_store", small_store(tmp_path))
    with TestClient(main.app) as client:
        response = client.post("/chat", json={
            "messages": [{"role": "user", "content": "Why do we add C?"}],
            "user_id": "private-student-id",
            "conversation_id": "conv-1",
            "model_choice": "edge",
            "lesson_context": "An integration lesson",
        })

    assert response.status_code == 200
    assert response.text.count("event: delta") == 2
    assert "Because the derivative" in response.text
    assert "$C$ is zero" in response.text
    assert response.text.rstrip().endswith('data: {"reason": "completed"}')
    assert "private-student-id" not in response.text


def test_chat_requires_final_user_message(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "get_teacher", lambda choice="edge": ChatTeacher())
    monkeypatch.setattr(main, "_learner_store", small_store(tmp_path))
    with TestClient(main.app) as client:
        response = client.post("/chat", json={
            "messages": [{"role": "assistant", "content": "Anything else?"}],
        })
    assert response.status_code == 422


def test_transcribe_validates_audio_and_removes_temp_file(monkeypatch) -> None:
    seen: list[Path] = []

    class FakeTranscriber:
        available = True

        async def transcribe(self, path: Path) -> dict:
            assert path.exists()
            seen.append(path)
            return {"text": "Explain the second term", "language": "en", "duration": 1.5}

    monkeypatch.setattr(main, "get_transcriber", lambda: FakeTranscriber())
    monkeypatch.setattr(main, "get_teacher", lambda choice="edge": ChatTeacher())
    with TestClient(main.app) as client:
        response = client.post(
            "/transcribe",
            files={"audio": ("recording.wav", b"fake-wav-audio", "audio/wav")},
        )
        rejected = client.post(
            "/transcribe",
            files={"audio": ("recording.txt", b"not audio", "text/plain")},
        )

    assert response.status_code == 200
    assert response.json()["text"] == "Explain the second term"
    assert rejected.status_code == 415
    assert seen and not seen[0].exists()
