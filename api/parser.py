"""Server-side incremental parser for the primitive tag protocol.

The model emits a stream of text chunks. We have to emit token events for
narrative and primitive events for complete tags - without ever losing a tag
that happens to be split across two chunks.

State machine:
  NARR           reading narrative text; '[' transitions to TAG_OPEN
  TAG_OPEN       inside [...]; ']' closes the tag (unless we're inside a quote)
  IN_DRAW_PART   inside a [draw_part: ...] ... [/draw_part] block, accumulating
                 raw body content until the closing marker is seen. The body
                 may contain newlines, brackets, and SVG/path text verbatim.
"""
from __future__ import annotations

import re
from typing import Iterator

_TAG_HEAD = re.compile(r"^\s*([a-zA-Z_]+)\s*:\s*(.*)$")

# argument parser: supports name="quoted with spaces", name=bareword, name=number
_ARG = re.compile(
    r"""([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s\]]+)""",
    re.VERBOSE,
)

# Quoted string at the head of the args section.
_QUOTED_HEAD = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*(.*)$', re.DOTALL)

# Each primitive that supports a positional first argument maps to the canonical
# arg name. Keeps the prompt friendly: [title: "X"] -> {text: "X"}, etc.
POSITIONAL_FIRST_ARG: dict[str, str] = {
    "title": "text",
    "text": "content",
    "equation": "latex",
}

# Block primitives have a body and a closing tag. Opening syntax is the same
# `[name: args]` shape; the parser switches to body-collection mode after the
# opening tag is consumed and stops at the matching closing tag.
BLOCK_PRIMITIVES: dict[str, str] = {
    "draw_part": "[/draw_part]",
}


def _unescape(s: str) -> str:
    """Unescape quoted string values.

    Recognises the standard JSON-style sequences (\\\\, \\", \\n, \\t, \\r).
    Everything else — crucially LaTeX commands like \\frac, \\int, \\sum — is
    left intact (backslash preserved). This means both single-escaped and
    double-escaped LaTeX survive:
        \\frac  →  \\  →  \\   (known escape, produces single \\)
        \frac   →  \\f  →  \\f (unknown escape, keeps both chars)
    Either way the downstream KaTeX call receives a valid \\frac.
    """
    out: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            if nxt == "\\":
                out.append("\\")
            elif nxt == '"':
                out.append('"')
            elif nxt == "n":
                out.append("\n")
            elif nxt == "t":
                out.append("\t")
            elif nxt == "r":
                out.append("\r")
            else:
                out.append("\\")
                out.append(nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _parse_args(arg_str: str, positional_key: str | None = None) -> dict[str, str]:
    """Parse the body of a tag past 'name:'.

    Accepts either keyed pairs (key=value), or - when positional_key is given -
    an optional leading quoted string treated as that key, followed by zero or
    more keyed pairs:

        [title: "Newton"]                          -> {text: "Newton"}
        [equation: "F=ma" align=center]            -> {latex: "F=ma", align: "center"}
        [box: id=A label="Block" w=80]             -> {id: A, label: "Block", w: "80"}
    """
    out: dict[str, str] = {}
    rest = arg_str.strip()
    if positional_key and rest.startswith('"'):
        m = _QUOTED_HEAD.match(rest)
        if m:
            out[positional_key] = _unescape(m.group(1))
            rest = m.group(2).strip()
    for m in _ARG.finditer(rest):
        key = m.group(1)
        raw = m.group(2)
        if raw.startswith('"') and raw.endswith('"'):
            val = _unescape(raw[1:-1])
        else:
            val = raw
        out[key] = val
    return out


class IncrementalTagParser:
    def __init__(self) -> None:
        self._buf: list[str] = []
        self._in_tag = False
        self._tag_buf: list[str] = []
        self._in_quote = False
        self._escape = False
        # When we are in NARR state we keep at most one trailing '[' so we
        # can distinguish "[" mid-text from the start of a tag once the next
        # token arrives.
        self._narr_pending = ""
        # IN_DRAW_PART state: when we see a [draw_part: ...] opening tag we
        # switch into body-collection mode. Body is accumulated as a list of
        # chars so we can cheaply detect the closing marker via a sliding tail
        # comparison without re-scanning the whole buffer per char.
        self._block_open: dict | None = None  # {tag, args, raw_body, close_marker}
        self._block_body: list[str] = []

    def feed(self, chunk: str) -> Iterator[dict]:
        for ch in chunk:
            if self._block_open is not None:
                yield from self._consume_block_char(ch)
            elif self._in_tag:
                yield from self._consume_tag_char(ch)
            else:
                yield from self._consume_narr_char(ch)

    def flush(self) -> Iterator[dict]:
        """Called at end of stream. Emits any buffered narrative as a token event;
        emits a half-finished draw_part block with whatever body it has so the
        lesson never silently drops a partial diagram; drops half-finished
        single-line tags (they would just be an LLM truncation).
        """
        if self._narr_pending:
            yield {"event": "token", "text": self._narr_pending}
            self._narr_pending = ""
        if self._buf:
            yield {"event": "token", "text": "".join(self._buf)}
            self._buf.clear()
        if self._block_open is not None:
            block = {
                "tag": self._block_open["tag"],
                "args": self._block_open["args"],
                "raw_body": self._block_open["raw_body"],
                "body": "".join(self._block_body),
            }
            self._block_open = None
            self._block_body = []
            yield {"event": "primitive", "tag": block}

    def _consume_narr_char(self, ch: str) -> Iterator[dict]:
        if ch == "[":
            # flush narrative buffer (excluding the pending '[' we are now committing)
            if self._buf or self._narr_pending:
                text = "".join(self._buf) + self._narr_pending
                self._buf.clear()
                self._narr_pending = ""
                if text:
                    yield {"event": "token", "text": text}
            self._in_tag = True
            self._tag_buf = []
            self._in_quote = False
            self._escape = False
            return
        # commit narr char
        self._buf.append(ch)
        # flush per-newline to keep TTS responsive
        if ch == "\n":
            text = "".join(self._buf)
            self._buf.clear()
            if text.strip():
                yield {"event": "token", "text": text}

    def _consume_tag_char(self, ch: str) -> Iterator[dict]:
        if self._escape:
            self._tag_buf.append(ch)
            self._escape = False
            return
        if self._in_quote:
            if ch == "\\":
                self._tag_buf.append(ch)
                self._escape = True
                return
            if ch == '"':
                self._in_quote = False
            self._tag_buf.append(ch)
            return
        if ch == '"':
            self._in_quote = True
            self._tag_buf.append(ch)
            return
        if ch == "]":
            tag_text = "".join(self._tag_buf)
            self._in_tag = False
            self._tag_buf = []
            parsed = self._parse_tag_body(tag_text)
            if parsed is None:
                # malformed; emit as text so we don't silently lose content
                yield {"event": "token", "text": f"[{tag_text}]"}
                return
            close_marker = BLOCK_PRIMITIVES.get(parsed["tag"])
            if close_marker is not None:
                # Enter block-collection mode. The opening tag's args and
                # raw_body are stashed; body chars stream in until close_marker.
                self._block_open = {
                    "tag": parsed["tag"],
                    "args": parsed["args"],
                    "raw_body": parsed.get("raw_body", ""),
                    "close_marker": close_marker,
                }
                self._block_body = []
                return
            yield {"event": "primitive", "tag": parsed}
            return
        if ch == "\n" and not self._in_quote:
            # Tag must be single-line. Treat newline mid-tag as abort -> narrative.
            text = "[" + "".join(self._tag_buf) + ch
            self._tag_buf = []
            self._in_tag = False
            yield {"event": "token", "text": text}
            return
        self._tag_buf.append(ch)

    def _consume_block_char(self, ch: str) -> Iterator[dict]:
        """Stream chars into the active block body; detect close marker by tail compare."""
        assert self._block_open is not None
        self._block_body.append(ch)
        marker = self._block_open["close_marker"]
        if len(self._block_body) >= len(marker):
            tail = "".join(self._block_body[-len(marker):])
            if tail == marker:
                # Strip the marker from the body and emit the primitive.
                del self._block_body[-len(marker):]
                block = {
                    "tag": self._block_open["tag"],
                    "args": self._block_open["args"],
                    "raw_body": self._block_open["raw_body"],
                    "body": "".join(self._block_body),
                }
                self._block_open = None
                self._block_body = []
                yield {"event": "primitive", "tag": block}
                return

    @staticmethod
    def _parse_tag_body(body: str) -> dict | None:
        m = _TAG_HEAD.match(body)
        if not m:
            return None
        name = m.group(1).strip().lower()
        positional_key = POSITIONAL_FIRST_ARG.get(name)
        raw_body = m.group(2).strip()
        args = _parse_args(raw_body, positional_key=positional_key)
        # Carry the raw body so the validator can salvage a positional value
        # when the model forgot to quote the string (e.g. [equation: F=ma]).
        return {"tag": name, "args": args, "raw_body": raw_body}
