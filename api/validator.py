"""Validate parsed tags against schema/primitives.json. Repair common mistakes.

Returns (ok, tag_dict). ok=False means we couldn't salvage the tag and the
caller should downgrade it to a [text: ...] narration so the lesson keeps
streaming without dropping content.
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
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
    "draw": {"code": "svg", "markup": "svg", "vb": "viewBox", "viewbox": "viewBox", "view_box": "viewBox", "width": "w", "height": "h", "label": "caption", "title": "caption"},
    "draw_part": {"label": "name", "title": "name", "part": "name", "vb": "viewBox", "viewbox": "viewBox", "view_box": "viewBox", "width": "w", "height": "h"},
}

# Allowed SVG element tags inside a [draw: svg="..."] body. Anything else is
# stripped during validation. Keep this short so the threat surface stays small
# and so the model is incentivised to write clean SVG.
_SVG_ALLOWED_ELEMENTS = {
    "g", "path", "circle", "rect", "line", "polyline", "polygon",
    "ellipse", "text", "tspan", "defs", "marker", "title",
}

# Attributes that may carry script-style content. Stripped unconditionally.
_SVG_FORBIDDEN_ATTR_PREFIXES = ("on",)
_SVG_FORBIDDEN_ATTR_NAMES = {"href", "xlink:href", "src"}

# Hard-deny element tags that make SVG dangerous (script execution, arbitrary
# HTML escape, network egress). Even if the element passed the allow-list we
# would never want these.
_SVG_DENY_ELEMENTS_PATTERN = re.compile(
    r"<\s*(?:script|foreignObject|iframe|image|use|animate|set)\b[^>]*>.*?<\s*/\s*(?:script|foreignObject|iframe|image|use|animate|set)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_SVG_DENY_ELEMENTS_VOID = re.compile(
    r"<\s*(?:script|foreignObject|iframe|image|use|animate|set)\b[^>]*/?>",
    re.IGNORECASE,
)
_SVG_EVENT_ATTR = re.compile(r"\son[a-zA-Z]+\s*=\s*(?:'[^']*'|\"[^\"]*\"|[^\s>]+)", re.IGNORECASE)
# Match the whole `<separator>href="javascript:..."` chunk including the
# whitespace that separates it from the previous attribute, so the result
# leaves no stray trailing space.
_SVG_JS_URL = re.compile(r"\s+(?:href|xlink:href|src)\s*=\s*(?:'\s*javascript:[^']*'|\"\s*javascript:[^\"]*\")", re.IGNORECASE)


def _sanitize_svg(svg: str) -> str:
    """Strip dangerous tags / attributes from inline SVG markup.

    This is a defence-in-depth pass; the renderer also rasterises the SVG to a
    PNG before placing it on the canvas, so nothing reaches a live DOM. We
    still strip here so a future renderer change can't accidentally re-enable
    script execution.
    """
    if not svg:
        return ""
    out = svg
    out = _SVG_DENY_ELEMENTS_PATTERN.sub("", out)
    out = _SVG_DENY_ELEMENTS_VOID.sub("", out)
    out = _SVG_EVENT_ATTR.sub("", out)
    out = _SVG_JS_URL.sub("", out)
    return out.strip()


# A path-data sequence is `M x y L x y C ... Z` etc. -- letters from the SVG
# command alphabet plus numbers, commas, dots, signs, and whitespace. We use
# this to classify body lines: those matching go inside a synthesised <path>;
# those starting with `<` are parsed as full SVG elements (after sanitize).
_PATH_DATA_LINE = re.compile(r"^[MmLlHhVvCcSsQqTtAaZz0-9eE\s\-,.\+]+$")
# Allowed SVG element names inside a [draw_part] body. Anything else is
# stripped during _process_draw_part_body (and the sanitizer is the second
# defence in depth).
_DRAW_PART_ALLOWED_ELEMENTS = {
    "path", "circle", "rect", "line", "polyline", "polygon",
    "ellipse", "text", "tspan", "g",
}
_LEADING_ELEMENT_NAME = re.compile(r"^<\s*([a-zA-Z][a-zA-Z0-9_-]*)")
# Valid SVG path command letters. Used to confirm a line that passed the
# character-class test actually contains at least one path operator (rejects
# all-digit garbage like a bare "1234 5678").
_PATH_COMMAND_LETTER = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]")
# Numeric token in path data. Pull each one and clamp to a sane range so a
# stray "M 999999 999999" doesn't blow up the viewBox.
_PATH_NUMBER = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")
# Outer cap: anything outside this is almost certainly a model glitch. We
# clamp to viewBox in renderer; here we just refuse pathological values.
_COORD_HARD_CAP = 1e5


def _path_data_is_sane(d: str) -> bool:
    """Return True if a path-d string contains at least one command letter
    and no numeric coordinate exceeds _COORD_HARD_CAP in magnitude.

    This catches two failure modes:
    1. The model wrote a comment-shaped line like "the body" that happens to
       only contain letters/digits/spaces/commas (would pass the char filter
       but is not real path data).
    2. The model emitted exploded coordinates like 1e9 that would create an
       enormous SVG.
    """
    if not _PATH_COMMAND_LETTER.search(d):
        return False
    for tok in _PATH_NUMBER.findall(d):
        try:
            v = float(tok)
        except ValueError:
            return False
        if v != v or abs(v) > _COORD_HARD_CAP:  # NaN -> v != v
            return False
    return True


def _validate_xml_element(line: str) -> bool:
    """Return True if `line` is a single, well-formed XML element using a
    whitelisted tag. Uses stdlib ElementTree so we don't take a lxml
    dependency. Self-closing elements and elements with text content are
    both accepted, as long as the element name is in the allow-list and the
    parser can parse the line cleanly.
    """
    try:
        # Pin a fake xmlns so attributes like xlink:href etc. fail-parse fast.
        elem = ET.fromstring(line)
    except ET.ParseError:
        return False
    name = elem.tag.split("}")[-1].lower() if "}" in elem.tag else elem.tag.lower()
    if name not in _DRAW_PART_ALLOWED_ELEMENTS:
        return False
    return True


def _process_draw_part_body(body: str) -> str:
    """Convert a [draw_part] body into a clean SVG inner string.

    Each non-empty line is either:
      - a path-data sequence (M ... L ... C ... Z) -> wrapped as <path d="...">
      - a whitelisted SVG element (<path .../>, <circle .../>, etc.) -> kept

    Lines that match neither are dropped. The output is run through
    `_sanitize_svg` as a final safety pass so script-style attributes never
    leak even if the model embedded them inline.

    Salvage policy: if at least one path / element line parses, the diagram
    is rendered with whatever survives. The validator only fails-soft (returns
    "") when zero lines survive.
    """
    if not body:
        return ""
    pieces: list[str] = []
    rejected = 0
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("<"):
            m = _LEADING_ELEMENT_NAME.match(line)
            if not m:
                rejected += 1
                continue
            elem_name = m.group(1).lower()
            if elem_name not in _DRAW_PART_ALLOWED_ELEMENTS:
                rejected += 1
                continue
            if not _validate_xml_element(line):
                # Malformed XML (missing closing tag, bad attribute syntax) -
                # drop and let the salvage policy keep the rest.
                rejected += 1
                continue
            pieces.append(line)
            continue
        # Treat as raw path-data; reject anything with non-path chars
        # (defensive: prevents the model from sneaking script-y text) and
        # anything where the data isn't actually SVG path syntax.
        if not _PATH_DATA_LINE.match(line) or not _path_data_is_sane(line):
            rejected += 1
            continue
        d_attr = line.replace('"', "&quot;")
        pieces.append(
            f'<path d="{d_attr}" stroke="#111" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        )
    if not pieces:
        return ""
    inner = "\n".join(pieces)
    return _sanitize_svg(inner)


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
    block_body: str = parsed.get("body", "")  # set only for block primitives

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

    if name == "draw":
        svg_raw = str(args.get("svg", ""))
        cleaned = _sanitize_svg(svg_raw)
        if not cleaned:
            return False, {"tag": "text", "args": {"content": "(diagram omitted)"}}
        args["svg"] = cleaned

    if name == "draw_part":
        part_name = str(args.get("name", "")).strip()
        cleaned = _process_draw_part_body(block_body)
        if not cleaned:
            label = part_name or "diagram"
            return False, {"tag": "text", "args": {"content": f"(skipped {label})"}}
        args["svg"] = cleaned
        if not part_name:
            args["name"] = "part"

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
