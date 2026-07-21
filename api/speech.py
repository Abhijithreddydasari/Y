"""Local Kokoro speech service through Moonshine Voice.

Only two explicitly approved Kokoro voices are exposed.  Piper and voice
cloning are intentionally absent from the public contract and asset setup.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import threading
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np


MODEL_VERSION = "moonshine-voice-0.0.69+kokoro-82m"
KOKORO_UPSTREAM_SHA256 = "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
MAX_TEXT_LENGTH = 500
MAX_CACHE_BYTES = 200 * 1024 * 1024
DEFAULT_VOICE = "kokoro_af_heart"


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    label: str
    locale: str
    default: bool = False


VOICES: tuple[VoiceInfo, ...] = (
    VoiceInfo("kokoro_af_heart", "Heart", "en-US", True),
    VoiceInfo("kokoro_am_michael", "Michael", "en-US", False),
)
VOICE_IDS = {voice.id for voice in VOICES}


class SpeechError(RuntimeError):
    pass


def _configure_moonshine_windows_crt() -> None:
    """Free Moonshine-owned buffers with the CRT used by its Windows DLL.

    Moonshine Voice 0.0.69 loads ``msvcrt`` on Windows, but its native DLL is
    built against the Universal CRT. Freeing the returned voice-catalog buffer
    through the former raises an access violation before Kokoro can load.
    """
    if os.name != "nt":
        return
    import ctypes
    import moonshine_voice.moonshine_api as moonshine_api

    ucrt = ctypes.CDLL("ucrtbase")
    ucrt.free.argtypes = [ctypes.c_void_p]
    ucrt.free.restype = None
    moonshine_api._libc = ucrt


class MoonshineSpeechEngine:
    def __init__(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        self.asset_root = Path(
            os.environ.get("MOONSHINE_VOICE_CACHE", repo_root / "data" / "tts-assets")
        ).expanduser()
        self.cache_root = Path(
            os.environ.get("SPEECH_CACHE_DIR", repo_root / "data" / "speech-cache")
        ).expanduser()
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self._engines: dict[str, object] = {}
        self.lock_path = Path(
            os.environ.get(
                "SPEECH_ASSET_LOCK",
                Path(__file__).resolve().parent / "speech_assets.lock.json",
            )
        )
        self._lock = threading.RLock()
        try:
            import moonshine_voice  # noqa: F401

            self._import_error = ""
        except Exception as exc:  # optional dependency guard
            self._import_error = str(exc)
        self._runtime_error = ""

    @property
    def available(self) -> bool:
        return not self._import_error and not self._runtime_error

    def health(self) -> dict:
        return {
            "available": self.available,
            "model_version": MODEL_VERSION,
            "asset_root": str(self.asset_root),
            "loaded_voices": sorted(self._engines),
            "error": self._runtime_error or self._import_error,
            "asset_lock": str(self.lock_path),
            "asset_lock_present": self.lock_path.exists(),
            "kokoro_upstream_sha256": KOKORO_UPSTREAM_SHA256,
        }

    def voices(self) -> list[dict]:
        return [asdict(voice) for voice in VOICES]

    def _engine(self, voice: str):
        if voice not in VOICE_IDS:
            raise SpeechError(f"voice is not allowlisted: {voice}")
        if not self.available:
            raise SpeechError(
                "Moonshine Voice is unavailable. Run `uv sync --extra speech`. "
                + self._import_error
            )
        if voice not in self._engines:
            _configure_moonshine_windows_crt()
            from moonshine_voice import TextToSpeech

            self.asset_root.mkdir(parents=True, exist_ok=True)
            try:
                engine = TextToSpeech(
                    "en-us",
                    voice=voice,
                    asset_root=self.asset_root,
                    download=True,
                )
            except Exception as exc:
                # Some Moonshine Windows wheels currently fail inside their
                # native voice-discovery call. Surface that as an optional
                # service outage so the web client can use Web Speech instead
                # of receiving an opaque 500 response.
                self._runtime_error = f"Moonshine initialization failed: {exc}"
                raise SpeechError(self._runtime_error) from exc
            self._engines[voice] = engine
            self.audit_assets(require_lock=os.environ.get("SPEECH_REQUIRE_LOCK") == "1")
        return self._engines[voice]

    def asset_hashes(self) -> dict[str, str]:
        if not self.asset_root.exists():
            return {}
        hashes: dict[str, str] = {}
        for path in sorted(self.asset_root.rglob("*")):
            if path.is_file():
                relative = path.relative_to(self.asset_root).as_posix()
                digest = hashlib.sha256()
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                hashes[relative] = digest.hexdigest()
        return hashes

    def audit_assets(self, *, require_lock: bool = False) -> dict:
        """Reject forbidden speech families and verify a generated asset lock."""
        hashes = self.asset_hashes()
        forbidden = [
            path for path in hashes
            if any(token in path.lower() for token in ("piper", "zipvoice", "espeak"))
        ]
        if forbidden:
            raise SpeechError("forbidden speech assets detected: " + ", ".join(forbidden[:5]))
        if self.lock_path.exists():
            expected = json.loads(self.lock_path.read_text(encoding="utf-8")).get("files", {})
            mismatched = [path for path, digest in expected.items() if hashes.get(path) != digest]
            unexpected = [path for path in hashes if path not in expected]
            if mismatched or unexpected:
                raise SpeechError(
                    f"speech asset lock mismatch (changed={mismatched[:3]}, unexpected={unexpected[:3]})"
                )
        elif require_lock:
            raise SpeechError("SPEECH_REQUIRE_LOCK=1 but speech_assets.lock.json is missing")
        return {"files": len(hashes), "forbidden": [], "locked": self.lock_path.exists()}

    def write_asset_lock(self) -> Path:
        audit = self.audit_assets(require_lock=False)
        payload = {
            "schema": "y-speech-assets-v1",
            "moonshine_voice": "0.0.69",
            "kokoro_upstream_sha256": KOKORO_UPSTREAM_SHA256,
            "voices": sorted(VOICE_IDS),
            "files": self.asset_hashes(),
            "audit": audit,
        }
        temp = self.lock_path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temp, self.lock_path)
        return self.lock_path

    @staticmethod
    def _validate(text: str, voice: str, speed: float) -> tuple[str, str, float]:
        clean = " ".join(str(text).split())
        if not clean:
            raise SpeechError("text is required")
        if len(clean) > MAX_TEXT_LENGTH:
            raise SpeechError(f"text exceeds {MAX_TEXT_LENGTH} characters")
        if voice not in VOICE_IDS:
            raise SpeechError(f"voice is not allowlisted: {voice}")
        try:
            speed = float(speed)
        except (TypeError, ValueError) as exc:
            raise SpeechError("speed must be numeric") from exc
        if speed < 0.8 or speed > 1.2:
            raise SpeechError("speed must be between 0.8 and 1.2")
        return clean, voice, speed

    def _cache_path(self, text: str, voice: str, speed: float) -> Path:
        digest = hashlib.sha256(
            json.dumps(
                [MODEL_VERSION, text, voice, round(speed, 3)],
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        return self.cache_root / f"{digest}.wav"

    @staticmethod
    def _to_wav(samples: object, sample_rate: int) -> bytes:
        pcm = np.asarray(samples, dtype=np.float32).reshape(-1)
        pcm = np.clip(pcm, -1.0, 1.0)
        pcm16 = (pcm * 32767.0).astype("<i2")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(int(sample_rate))
            wav.writeframes(pcm16.tobytes())
        return output.getvalue()

    def _evict(self) -> None:
        files = sorted(
            (path for path in self.cache_root.glob("*.wav") if path.is_file()),
            key=lambda path: path.stat().st_mtime,
        )
        total = sum(path.stat().st_size for path in files)
        for path in files:
            if total <= MAX_CACHE_BYTES:
                break
            size = path.stat().st_size
            try:
                path.unlink()
                total -= size
            except OSError:
                continue

    def synthesize_sync(
        self,
        text: str,
        voice: str = DEFAULT_VOICE,
        speed: float = 1.0,
    ) -> tuple[bytes, dict]:
        text, voice, speed = self._validate(text, voice, speed)
        cache_path = self._cache_path(text, voice, speed)
        if cache_path.exists():
            audio = cache_path.read_bytes()
            return audio, {
                "voice": voice,
                "model_version": MODEL_VERSION,
                "cached": True,
            }
        with self._lock:
            if cache_path.exists():
                return cache_path.read_bytes(), {
                    "voice": voice,
                    "model_version": MODEL_VERSION,
                    "cached": True,
                }
            engine = self._engine(voice)
            try:
                samples, sample_rate = engine.synthesize(text, options={"speed": speed})
            except Exception as exc:
                raise SpeechError(f"Kokoro synthesis failed: {exc}") from exc
            audio = self._to_wav(samples, int(sample_rate))
            temp = cache_path.with_suffix(".wav.tmp")
            temp.write_bytes(audio)
            os.replace(temp, cache_path)
            self._evict()
            duration = len(samples) / max(1, int(sample_rate))
            return audio, {
                "voice": voice,
                "model_version": MODEL_VERSION,
                "cached": False,
                "sample_rate": int(sample_rate),
                "duration_seconds": round(duration, 4),
            }

    async def synthesize(
        self,
        text: str,
        voice: str = DEFAULT_VOICE,
        speed: float = 1.0,
    ) -> tuple[bytes, dict]:
        return await asyncio.to_thread(self.synthesize_sync, text, voice, speed)

    async def prefetch(self) -> None:
        if not self.available:
            return
        for voice in VOICE_IDS:
            await asyncio.to_thread(self._engine, voice)
        await asyncio.to_thread(
            self.audit_assets,
            require_lock=os.environ.get("SPEECH_REQUIRE_LOCK") == "1",
        )


_speech_engine: MoonshineSpeechEngine | None = None


def get_speech_engine() -> MoonshineSpeechEngine:
    global _speech_engine
    if _speech_engine is None:
        _speech_engine = MoonshineSpeechEngine()
    return _speech_engine
