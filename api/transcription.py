"""Speech-to-text: Muse Voice Transcribe for the tutor, local Moonshine for the legacy chat.

The tutor path sends one push-to-talk WAV to Meta's file endpoint with keyword
hints taken from the board. The legacy chat composer keeps Moonshine's bundled
tiny English model (MIT, offline). Both are independent from speech.py and the
Kokoro narration lifecycle.
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import re
import threading
import time
import wave
from pathlib import Path

import httpx


class TranscriptionError(RuntimeError):
    pass


MUSE_URL = "https://api.meta.ai/v1/asr/transcribe"
MUSE_MODEL = "muse-voice-transcribe-1.0"
MAX_WAV_BYTES = 1_100_000  # 30 s of 16 kHz mono PCM plus header
MAX_SECONDS = 31.0
MIN_SECONDS = 0.25
MAX_KEYWORDS = 30
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)
_STOP = frozenset("""about above after again also because before being below between both could does doing down during each
from further have having here into itself just more most only other over same should some such than that their them then
there these they this those through under until very what when where which while with would your yours answer check
predict means equal equals step first next""".split())
_GREEK = frozenset("""alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega rho tau phi psi chi eta mu nu xi
pi""".split())


class TranscribeFailure(TranscriptionError):
    """A transcription failure with a safe, stable code for the client."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def wav_info(audio: bytes) -> tuple[int, float]:
    """Sample rate and duration of a PCM WAV; anything else is rejected before a paid call."""
    if len(audio) > MAX_WAV_BYTES:
        raise TranscribeFailure("audio_too_large")
    try:
        with wave.open(io.BytesIO(audio)) as wav:
            rate, frames = wav.getframerate(), wav.getnframes()
            valid = wav.getsampwidth() == 2 and wav.getnchannels() in (1, 2) and 8_000 <= rate <= 48_000
    except (wave.Error, EOFError) as exc:
        raise TranscribeFailure("audio_invalid") from exc
    if not valid:
        raise TranscribeFailure("audio_invalid")
    duration = frames / rate
    if duration > MAX_SECONDS:
        raise TranscribeFailure("audio_too_long")
    if duration < MIN_SECONDS:
        raise TranscribeFailure("no_speech")
    return rate, duration


def keyword_hints(texts: list[str], limit: int = MAX_KEYWORDS) -> list[str]:
    """Distinctive terms from board text and LaTeX, most recent sources first, deduped and capped."""
    seen: set[str] = set()
    terms: list[str] = []
    for text in texts:
        plain = re.sub(r"\\(?:text|mathrm|operatorname|mathbf)\{([^}]*)\}", r" \1 ", text or "")
        plain = re.sub(r"\\([A-Za-z]+)", lambda m: f" {m[1]} " if m[1].lower() in _GREEK else " ", plain)
        for word in re.findall(r"[A-Za-z][A-Za-z0-9_'-]*[A-Za-z0-9]", plain):
            word = word.strip("'-")
            key = word.lower()
            technical = any(c.isdigit() or c == "_" for c in word) or word[1:] != word[1:].lower()
            if key in seen or key in _STOP or len(word) > 40 or (len(word) < 4 and not technical and key not in _GREEK):
                continue
            seen.add(key)
            terms.append(word)
            if len(terms) >= limit:
                return terms
    return terms


class MuseTranscriber:
    """Meta's file transcription endpoint over the app's shared HTTP client."""

    def __init__(self, client: httpx.AsyncClient, api_key: str | None = None):
        self.client = client
        self.api_key = (os.environ.get("MODEL_API_KEY", "") if api_key is None else api_key).strip()
        self.timing: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def warm(self) -> None:
        """Open a pooled TLS connection while the learner is still speaking; failures are irrelevant."""
        if not self.api_key:
            return
        try:
            await self.client.head(MUSE_URL.rsplit("/asr", 1)[0], timeout=httpx.Timeout(3.0))
        except httpx.HTTPError:
            pass

    async def transcribe(self, audio: bytes, keywords: list[str]) -> dict:
        if not self.api_key:
            raise TranscribeFailure("transcribe_not_configured")
        rate, duration = wav_info(audio)
        request = {"model": MUSE_MODEL, "audioEncoding": "WAV", "sampleRateHertz": rate}
        if keywords:
            request["keywords"] = keywords[:MAX_KEYWORDS]
        started = time.perf_counter()
        try:
            response = await self.client.post(
                MUSE_URL, headers={"Authorization": f"Bearer {self.api_key}"}, timeout=_TIMEOUT,
                files={"request": (None, json.dumps(request), "application/json"), "audio": ("speech.wav", audio, "audio/wav")})
        except httpx.TimeoutException as exc:
            raise TranscribeFailure("transcribe_timeout") from exc
        except httpx.HTTPError as exc:
            raise TranscribeFailure("transcribe_failed") from exc
        self.timing["provider_ms"] = (time.perf_counter() - started) * 1000
        if response.status_code in (401, 403):
            raise TranscribeFailure("transcribe_auth_failed")
        if response.status_code == 429:
            raise TranscribeFailure("transcribe_rate_limited")
        if response.status_code != 200:
            raise TranscribeFailure("transcribe_failed")
        try:
            text = " ".join(str(response.json().get("transcript") or "").split())
        except ValueError as exc:
            raise TranscribeFailure("transcribe_failed") from exc
        if not text:
            raise TranscribeFailure("no_speech")
        return {"text": text[:2000], "duration": round(duration, 3), "model": MUSE_MODEL, "keywords": len(request.get("keywords", []))}


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
