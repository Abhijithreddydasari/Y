from __future__ import annotations

import json
import wave
from io import BytesIO

import numpy as np
import pytest

from speech import MoonshineSpeechEngine, SpeechError


class FakeKokoro:
    calls = 0

    def synthesize(self, text: str, options: dict):
        self.calls += 1
        assert options["speed"] == 1.0
        return np.zeros(2400, dtype=np.float32), 24000


def test_allowlist_wav_and_cache(tmp_path, monkeypatch) -> None:
    engine = MoonshineSpeechEngine()
    engine.cache_root = tmp_path / "cache"
    engine.cache_root.mkdir()
    engine._import_error = ""
    fake = FakeKokoro()
    monkeypatch.setattr(engine, "_engine", lambda voice: fake)
    first, meta1 = engine.synthesize_sync("A short explanation.")
    second, meta2 = engine.synthesize_sync("A short explanation.")
    assert first == second
    assert meta1["cached"] is False
    assert meta2["cached"] is True
    assert fake.calls == 1
    with wave.open(BytesIO(first), "rb") as wav:
        assert wav.getframerate() == 24000
        assert wav.getnchannels() == 1


def test_speech_rejects_unapproved_voice_and_long_text(tmp_path) -> None:
    engine = MoonshineSpeechEngine()
    engine.cache_root = tmp_path
    with pytest.raises(SpeechError, match="allowlisted"):
        engine.synthesize_sync("hello", voice="piper_voice")
    with pytest.raises(SpeechError, match="500"):
        engine.synthesize_sync("x" * 501)


def test_speech_asset_audit_rejects_forbidden_and_modified_files(tmp_path) -> None:
    engine = MoonshineSpeechEngine()
    engine.asset_root = tmp_path / "assets"
    engine.asset_root.mkdir()
    engine.lock_path = tmp_path / "speech_assets.lock.json"

    forbidden = engine.asset_root / "piper_voice.onnx"
    forbidden.write_bytes(b"forbidden")
    with pytest.raises(SpeechError, match="forbidden speech assets"):
        engine.audit_assets()

    forbidden.unlink()
    allowed = engine.asset_root / "kokoro_model.onnx"
    allowed.write_bytes(b"known-model")
    engine.write_asset_lock()
    lock = json.loads(engine.lock_path.read_text(encoding="utf-8"))
    assert lock["files"]["kokoro_model.onnx"]
    assert engine.audit_assets(require_lock=True)["locked"] is True

    allowed.write_bytes(b"tampered-model")
    with pytest.raises(SpeechError, match="asset lock mismatch"):
        engine.audit_assets(require_lock=True)


def test_native_initialization_failure_disables_optional_engine(
    tmp_path, monkeypatch
) -> None:
    import moonshine_voice

    engine = MoonshineSpeechEngine()
    engine.asset_root = tmp_path / "assets"
    engine._import_error = ""

    class BrokenTextToSpeech:
        def __init__(self, *args, **kwargs) -> None:
            raise OSError("native voice discovery failed")

    monkeypatch.setattr(moonshine_voice, "TextToSpeech", BrokenTextToSpeech)

    with pytest.raises(SpeechError, match="Moonshine initialization failed"):
        engine._engine("kokoro_af_heart")

    assert engine.available is False
    assert "native voice discovery failed" in engine.health()["error"]
    assert engine.health()["loaded_voices"] == []
