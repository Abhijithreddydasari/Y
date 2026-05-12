"""Validate parsed tags against schema/primitives.json. Repair common mistakes.

Returns (ok, tag_dict). ok=False means we couldn't salvage the tag and the
caller should downgrade it to a [text: ...] narration so the lesson keeps
streaming without dropping content.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "primitives.json"

# When the model emits a positional-supporting tag without quotes, we salvage
# the raw body into the canonical arg. Keep in sync with parser.POSITIONAL_FIRST_ARG.
POSITIONAL_FIRST_ARG: dict[str, str] = {
    "title": "text",
    "text": "content",
    "equation": "latex",
}


@lru_cache(maxsize=1)
def _schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _known_primitives() -> dict[str, dict]:
    return _schema()["primitives"]


# Some common nicknames the model may emit; map to canonical names.
_ALIASES = {
    "heading": "title",
    "h1": "title",
    "header": "title",
    "narration": "text",
    "paragraph": "text",
    "say": "text",
    "math": "equation",
    "eq": "equation",
    "formula": "equation",
    "rect": "box",
    "rectangle": "box",
    "circle": "node",
    "ellipse": "node",
    "edge": "arrow",
    "connect": "arrow",
    "segment": "line",
    "vector": "line",
}

# Per-primitive arg aliases.
_ARG_ALIASES = {
    "title": {"label": "text", "value": "text"},
    "text": {"text": "content", "value": "content", "label": "content"},
    "equation": {"text": "latex", "value": "latex", "tex": "latex"},
    "box": {"name": "id", "title": "label"},
    "node": {"name": "id", "title": "label", "radius": "r"},
    "arrow": {"src": "from", "source": "from", "dst": "to", "target": "to", "text": "label"},
    "line": {"text": "label", "start_x": "x1", "start_y": "y1", "end_x": "x2", "end_y": "y2"},
}


def _coerce_number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def validate_and_repair(parsed: dict) -> tuple[bool, dict]:
    """Return (ok, tag). If ok=False, tag is a [text] fallback wrapping the original input."""
    name_raw = parsed.get("tag", "").lower()
    name = _ALIASES.get(name_raw, name_raw)
    args = dict(parsed.get("args", {}))
    raw_body: str = parsed.get("raw_body", "")

    if name not in _known_primitives():
        fallback_text = _stringify_unknown(parsed)
        return False, {"tag": "text", "args": {"content": fallback_text}}

    spec = _known_primitives()[name]["args"]
    valid_keys = set(spec.keys())

    # Apply per-primitive arg aliases.
    arg_aliases = _ARG_ALIASES.get(name, {})
    remapped: dict[str, str] = {}
    for k, v in args.items():
        target = arg_aliases.get(k, k)
        remapped[target] = v
    args = remapped

    # If this primitive supports a positional first arg and we didn't capture
    # one (because the model wrote it unquoted, e.g. [equation: F=ma]), salvage
    # the raw body as the positional value, BUT only if none of the parsed
    # keys are valid for this primitive (i.e. we're not stealing real args).
    pos_key = POSITIONAL_FIRST_ARG.get(name)
    if pos_key and pos_key not in args and raw_body:
        recognized = [k for k in args if k in valid_keys]
        if not recognized:
            cleaned = raw_body.strip().strip(",").strip()
            if cleaned.startswith('"') and cleaned.endswith('"'):
                cleaned = cleaned[1:-1]
            if cleaned:
                args = {pos_key: cleaned}

    # Drop args that are not in the schema (avoids passing garbage downstream).
    args = {k: v for k, v in args.items() if k in valid_keys}

    # Numeric coercion for number-typed args.
    coerced: dict[str, object] = {}
    for k, v in args.items():
        if spec[k].get("type") == "number":
            num = _coerce_number(str(v))
            if num is not None:
                coerced[k] = num
            # silently drop unparseable numerics
        else:
            coerced[k] = v
    args = coerced

    # Required arg check.
    missing = [k for k, schema in spec.items() if schema.get("required") and k not in args]
    if missing:
        return False, {"tag": "text", "args": {"content": _stringify_unknown({"tag": name, "args": args, "raw_body": raw_body})}}

    # Fill defaults for optional args (so frontend doesn't have to know schema defaults).
    for k, schema in spec.items():
        if k not in args and "default" in schema:
            args[k] = schema["default"]

    return True, {"tag": name, "args": args}


def _stringify_unknown(parsed: dict) -> str:
    """When we have to fall back, surface a human-readable string so nothing is lost.

    Prefer the raw body the model wrote; fall back to a synthesized form so the
    student still sees content even on malformed tags.
    """
    raw = parsed.get("raw_body", "")
    if raw:
        return raw.strip().strip('"')
    args = parsed.get("args", {})
    parts = [f"{k}={v}" for k, v in args.items()]
    return f"[{parsed.get('tag', '?')}: {' '.join(parts)}]".strip()
