"""Local, lazy speech-to-text for the chat composer.

The STT path uses Moonshine's bundled tiny English model. Moonshine Voice and
its model are MIT-licensed, run fully offline, and are already part of Y's
runtime. This module is deliberately independent from speech.py and the
Kokoro narration lifecycle.
"""
from __future__ import annotations

import asyncio
import importlib.util
import threading
from pathlib import Path


class TranscriptionError(RuntimeError):
    pass


class MoonshineTranscriber:
    def __init__(self) -> None:
        self.model_name = "moonshine-tiny-en"
        self._model = None
        self._model_path: Path | None = None
        self._load_lock = threading.Lock()
        self._run_lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        if importlib.util.find_spec("moonshine_voice") is None:
            return False
        try:
            from moonshine_voice import get_assets_path

            root = Path(get_assets_path()) / "tiny-en"
            return root.is_dir() and (root / "encoder_model.ort").exists()
        except Exception:
            return False

    def health(self) -> dict:
        return {
            "available": self.available,
            "model": self.model_name,
            "loaded": self._model is not None,
            "device": "cpu",
            "compute_type": "moonshine-quantized",
            "install_hint": "uv sync --extra stt" if not self.available else "",
        }

    def _ensure_model(self):
        if self._model is not None:
            return self._model
        if not self.available:
            raise TranscriptionError(
                "Local transcription is not installed. Run `uv sync --extra stt` in api."
            )
        with self._load_lock:
            if self._model is not None:
                return self._model
            try:
                from moonshine_voice import ModelArch, Transcriber, get_assets_path

                self._model_path = Path(get_assets_path()) / "tiny-en"
                self._model = Transcriber(self._model_path, ModelArch.TINY)
            except Exception as exc:
                raise TranscriptionError(f"Unable to load Moonshine STT: {exc}") from exc
        return self._model

    def _transcribe_sync(self, audio_path: Path) -> dict:
        model = self._ensure_model()
        try:
            from moonshine_voice import load_wav_file

            samples, sample_rate = load_wav_file(str(audio_path))
            if not samples:
                return {"text": "", "language": "en", "duration": 0.0}
            duration = len(samples) / max(1, sample_rate)
            if duration > 65:
                raise TranscriptionError("Recording exceeds the 60 second chat limit")
            transcript = model.transcribe_without_streaming(samples, sample_rate)
            text = " ".join(
                line.text.strip()
                for line in transcript.lines
                if line.text and line.text.strip()
            ).strip()
            return {
                "text": text,
                "language": "en",
                "duration": duration,
                "model": self.model_name,
                "device": "cpu",
            }
        except TranscriptionError:
            raise
        except Exception as exc:
            raise TranscriptionError(f"Transcription failed: {exc}") from exc

    async def transcribe(self, audio_path: Path) -> dict:
        # The native model instance is shared; serialize calls so multiple
        # browser tabs cannot race its internal handle.
        async with self._run_lock:
            return await asyncio.to_thread(self._transcribe_sync, audio_path)


_transcriber: MoonshineTranscriber | None = None
_singleton_lock = threading.Lock()


def get_transcriber() -> MoonshineTranscriber:
    global _transcriber
    if _transcriber is None:
        with _singleton_lock:
            if _transcriber is None:
                _transcriber = MoonshineTranscriber()
    return _transcriber
