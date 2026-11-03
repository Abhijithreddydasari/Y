"""The trace drawer's rows: which model did what in a session and how long each stage took.

Reads timings the stages already store; no prompts, answers or keys leave the server.
"""
from __future__ import annotations

MAX_TURNS = 40
_TURN_MS = ("context_ms", "headers_ms", "first_token_ms", "first_move_ms", "stream_ms", "total_ms")
_USAGE = ("input_tokens", "cached_tokens", "output_tokens", "reasoning_tokens")


def _ms(value) -> int | None:
    return round(value) if isinstance(value, (int, float)) else None


def turn_row(turn: dict) -> dict:
    timing = turn["timing"] or {}
    provider = timing.get("provider") or {}
    merged = {**timing, **provider}
    goal = next((m["goal"] for m in turn["moves"] if m["type"] == "seg"), "")
    return {"stage": "turn", "seq": turn["seq"], "kind": turn["kind"], "status": turn["status"], "at": turn.get("at"),
            "goal": goal[:80], "tutor": timing.get("tutor"),
            "ms": {k: _ms(merged.get(k)) for k in _TURN_MS if _ms(merged.get(k)) is not None},
            "usage": {k: v for k, v in (timing.get("usage") or {}).items() if k in _USAGE},
            "moves": len(turn["moves"]), "dropped": len(timing.get("dropped") or []), "repairs": timing.get("repairs", 0),
            "error": timing.get("error"), "points": timing.get("points") or [],
            # A warm-up review is drawn from a stored check with no model call.
            "model_call": turn["kind"] != "review"}


def hint_row(hint: dict) -> dict:
    return {"stage": "hint", "qid": hint["qid"], "level": hint["level"], "at": hint.get("at"), "ms": _ms(hint.get("ms")),
            "tutor": hint.get("tutor"), "usage": {k: v for k, v in (hint.get("usage") or {}).items() if k in _USAGE}}


def label_row(entry: dict) -> dict:
    label = entry.get("label") or {}
    observation = entry.get("observation") or {}
    return {"stage": "label", "qid": entry["qid"], "status": entry["status"], "error": entry["error"],
            "labeler": observation.get("labeler") or label.get("provider"), "model": label.get("model"),
            "verifier": entry.get("verifier"), "modality": entry.get("modality"), "images": label.get("images"),
            "ms": {k: v for k, v in {"label_ms": entry.get("label_ms"), "provider_ms": label.get("provider_ms"),
                                     "queue_ms": label.get("queue_ms")}.items() if v is not None}}


def close_row(close: dict | None, model: str) -> dict | None:
    if not close:
        return None
    notes = close.get("notes_trace") or {}
    return {"stage": "close", "revision": close.get("revision"), "ms": close.get("ms"), "sealed": close.get("sealed"),
            "notes_model": model, "notes": {k: notes[k] for k in ("kept", "dropped", "named", "names_dropped", "links",
                                                                   "links_dropped", "error") if k in notes},
            "relabel": close.get("relabel")}


def session_trace(turns: list[dict], hints: list[dict], entries: list[dict], close: dict | None, notes_model: str) -> dict:
    return {"turns": [turn_row(t) for t in turns[-MAX_TURNS:]], "hints": [hint_row(h) for h in hints],
            "labels": [label_row(e) for e in entries], "close": close_row(close, notes_model)}
