"""Tutor model and voice options: a server-side allowlist the browser picks from by id.

The browser never sends a provider model name, base URL or key; it sends an option id, which is
resolved here. Availability reflects configuration (keys) and the speech engine, with a reason.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

META_BASE = "https://api.meta.ai/v1"
BASETEN_BASE = "https://inference.baseten.co/v1"
PROVIDERS = {"meta": (META_BASE, "MODEL_API_KEY"), "baseten": (BASETEN_BASE, "BASETEN_API_KEY")}


@dataclass(frozen=True)
class TutorOption:
    id: str
    label: str
    note: str
    provider: str
    model: str
    effort: str | None


# Labels follow measurements in docs/decisions/2026-11-01-harness.md and docs/handoffs/H3.md.
OPTIONS: tuple[TutorOption, ...] = (
    TutorOption("spark-1.3", "Muse Spark 1.3", "Balanced: fast and reliable", "meta", "muse-spark-1.3", "minimal"),
    TutorOption("spark-1.3-low", "Muse Spark 1.3 · think more", "Careful: about 2-3 s slower to start", "meta",
                "muse-spark-1.3", "low"),
    TutorOption("spark-1.2", "Muse Spark 1.2", "Quicker, less reliable on structured moves", "meta", "muse-spark-1.2",
                "minimal"),
    # Without an effort cap it spent all 3,000 output tokens reasoning in 4 of 5 live turns.
    TutorOption("spark-open", "Muse Spark Open", "Open weights on Baseten", "baseten", "meta-models/muse-spark-open-1026",
                "low"),
)
DEFAULT_OPTION = OPTIONS[0]
_BY_ID = {option.id: option for option in OPTIONS}
VOICE_OPTIONS = (("kokoro_af_heart", "Heart", "Kokoro, warm"), ("kokoro_am_michael", "Michael", "Kokoro, calm"))


class OptionUnavailable(ValueError):
    pass


def api_key(option: TutorOption) -> str:
    return os.environ.get(PROVIDERS[option.provider][1], "").strip()


def default_option() -> TutorOption:
    model = os.environ.get("META_TUTOR_MODEL", "").strip()
    return TutorOption(**{**DEFAULT_OPTION.__dict__, "model": model}) if model else DEFAULT_OPTION


def resolve(option_id: str | None) -> TutorOption:
    """The option for an id from the browser; unknown or unconfigured ids raise before any paid call."""
    if option_id is None or option_id == DEFAULT_OPTION.id:
        return default_option()
    option = _BY_ID.get(option_id)
    if option is None:
        raise OptionUnavailable("tutor_model_unknown")
    if not api_key(option):
        raise OptionUnavailable("tutor_model_unavailable")
    return option


def tutor_options() -> list[dict]:
    out = []
    for option in OPTIONS:
        ready = bool(api_key(option))
        out.append({"id": option.id, "label": option.label, "note": option.note, "effort": option.effort,
                    "default": option is DEFAULT_OPTION, "available": ready,
                    "reason": None if ready else "Not configured on this server"})
    return out


def voice_options(engine) -> list[dict]:
    ready = bool(engine and engine.available)
    reason = None if ready else "Kokoro is not installed on this server"
    voices = [{"id": vid, "label": label, "note": note, "default": vid == "kokoro_af_heart", "available": ready,
               "reason": reason} for vid, label, note in VOICE_OPTIONS]
    return voices + [{"id": "browser", "label": "Browser voice", "note": "Instant, sounds robotic", "default": False,
                      "available": True, "reason": None},
                     {"id": "off", "label": "Off", "note": "Captions only", "default": False, "available": True,
                      "reason": None}]
