from __future__ import annotations

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
