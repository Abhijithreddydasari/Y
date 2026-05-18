"""Last-resort salvage: convert raw LLM text into synthetic primitives.

When the model completely ignores the system prompt and emits plain text,
JSON detection blobs, or markdown instead of our tag protocol, this module
extracts the useful content and synthesises primitives so the whiteboard
still draws *something*.

Called by main.py only when the parser yields 0 primitives from the full
response. Never runs on well-formed output.
"""
from __future__ import annotations

import json
import re


_MATH_PATTERN = re.compile(
    r"(?:"
    r"\$\$(.+?)\$\$"           # $$...$$ display math
    r"|\$(.+?)\$"              # $...$ inline math
    r"|\\\[(.+?)\\\]"         # \[...\]
    r"|\\\((.+?)\\\)"         # \(...\)
    r"|([A-Za-z]\s*=\s*[^,\n]{2,40})"  # bare assignment like F = m * a
    r")",
    re.DOTALL,
)

_HEADING_LINE = re.compile(r"^#{1,3}\s+(.+)$", re.MULTILINE)
_NUMBERED_STEP = re.compile(r"^\s*(\d+)\.\s+(.+)$", re.MULTILINE)
_BULLET_LINE = re.compile(r"^\s*[\-\*\u2022]\s+(.+)$", re.MULTILINE)


def _extract_text_content_from_json(raw: str) -> str | None:
    """If the raw text is a Gemma 4 vision JSON detection blob, pull out
    the ``text_content`` field. Returns None if the blob doesn't match."""
    stripped = raw.strip()
    if not stripped.startswith("[") and not stripped.startswith("{"):
        return None
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError:
        # Might be truncated. Try wrapping with `]`.
        try:
            obj = json.loads(stripped + "]")
        except json.JSONDecodeError:
            return None
    if isinstance(obj, list):
        parts = []
        for item in obj:
            if isinstance(item, dict) and "text_content" in item:
                parts.append(str(item["text_content"]))
        return "\n".join(parts) if parts else None
    if isinstance(obj, dict) and "text_content" in obj:
        return str(obj["text_content"])
    return None


def _strip_markdown(text: str) -> str:
    """Remove markdown formatting while preserving text content."""
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"_(.+?)_", r"\1", text)
    text = re.sub(r"`(.+?)`", r"\1", text)
    return text


def salvage_raw_to_primitives(raw: str) -> list[dict]:
    """Convert raw model output into a list of validated primitive dicts.

    Returns an empty list only if the input is truly empty/useless.
    """
    if not raw or not raw.strip():
        return []

    # Try JSON vision-detection format first.
    extracted = _extract_text_content_from_json(raw)
    text = extracted if extracted else raw

    text = _strip_markdown(text)
    primitives: list[dict] = []

    # Extract a title from the first heading or first non-empty line.
    heading_m = _HEADING_LINE.search(text)
    if heading_m:
        primitives.append({"tag": "title", "args": {"text": heading_m.group(1).strip()}})
        text = text[:heading_m.start()] + text[heading_m.end():]

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not primitives and lines:
        # Use first line as title if it looks title-like (short, no math).
        first = lines[0]
        if len(first) < 80 and "=" not in first:
            primitives.append({"tag": "title", "args": {"text": first}})
            lines = lines[1:]

    for line in lines:
        if not line:
            continue

        # Check for math content: equations with = signs and variables.
        # Matches lines like "a = F / m", "F = 10 N", "Result: a = 5 m/s^2"
        eq_match = re.match(
            r"^(?:[\w\s]*:\s*)?([A-Za-z_]\w*\s*=\s*.+)$",
            line, re.IGNORECASE,
        )
        if eq_match:
            candidate = eq_match.group(1).strip()
            # Only treat as equation if the RHS has math-like content
            # (numbers, operators, variables) not just prose.
            rhs = candidate.split("=", 1)[1].strip() if "=" in candidate else ""
            is_mathy = bool(re.search(r"\d", rhs)) or bool(re.search(r"[+\-*/^]", rhs))
            if is_mathy and len(candidate) < 60:
                latex = candidate
                latex = latex.replace("*", r" \cdot ")
                latex = latex.replace("^2", "^{2}")
                latex = latex.replace("^3", "^{3}")
                primitives.append({"tag": "equation", "args": {"latex": latex, "align": "center"}})
                continue

        # Numbered step lines.
        step_m = _NUMBERED_STEP.match(line)
        if step_m:
            content = step_m.group(2).strip()
            # Check if step content has "label: equation" form.
            colon_m = re.match(r"^[\w\s]+:\s*([A-Za-z_]\w*\s*=\s*.+)$", content)
            if colon_m:
                eq_part = colon_m.group(1).strip()
                rhs_part = eq_part.split("=", 1)[1].strip() if "=" in eq_part else ""
                if bool(re.search(r"\d", rhs_part)) or bool(re.search(r"[+\-*/^]", rhs_part)):
                    eq_part = eq_part.replace("*", r" \cdot ")
                    eq_part = eq_part.replace("^2", "^{2}").replace("^3", "^{3}")
                    primitives.append({"tag": "equation", "args": {"latex": eq_part, "align": "center"}})
                    continue
            # Check if the step content is a bare equation.
            if re.match(r"^[A-Za-z_]\w*\s*=\s*", content):
                rhs_part = content.split("=", 1)[1].strip()
                if bool(re.search(r"\d", rhs_part)) or bool(re.search(r"[+\-*/^]", rhs_part)):
                    content = content.replace("*", r" \cdot ")
                    content = content.replace("^2", "^{2}").replace("^3", "^{3}")
                    primitives.append({"tag": "equation", "args": {"latex": content, "align": "center"}})
                    continue
            if len(content) > 80:
                content = content[:77] + "..."
            primitives.append({"tag": "text", "args": {"content": content}})
            continue

        # Bullet lines.
        bullet_m = _BULLET_LINE.match(line)
        if bullet_m:
            content = bullet_m.group(1).strip()
            if len(content) > 80:
                content = content[:77] + "..."
            primitives.append({"tag": "text", "args": {"content": content}})
            continue

        # Skip lines that are just section labels with no content.
        if re.match(r"^(?:given|find|solution|answer|problem|step\s*\d*)\s*:?\s*$", line, re.IGNORECASE):
            continue

        # Generic text line (skip very short noise like ":" or "---").
        if len(line) > 2:
            content = line
            if len(content) > 80:
                content = content[:77] + "..."
            primitives.append({"tag": "text", "args": {"content": content}})

    # Cap at 20 primitives to avoid overwhelming the whiteboard.
    return primitives[:20]
