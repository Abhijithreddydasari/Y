"""Server-side incremental parser for the primitive tag protocol.

The model emits a stream of text chunks. We have to emit token events for
narrative and primitive events for complete tags - without ever losing a tag
that happens to be split across two chunks.

State machine:
  NARR       reading narrative text; '[' transitions to TAG_OPEN
  TAG_OPEN   inside [...]; ']' closes the tag (unless we're inside a quote)
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


def _unescape(s: str) -> str:
    """JSON-style escape unescaping for quoted string values.

    Handle \\\\ first so we don't accidentally un-escape a sequence the user
    wanted to keep doubled. Single-pass; we do NOT loop because the model is
    instructed to write only the JSON-style single layer (e.g. \\\\frac means \\frac).
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
                # unknown escape: drop the backslash, keep the char (most LLM-friendly)
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

    def feed(self, chunk: str) -> Iterator[dict]:
        for ch in chunk:
            if self._in_tag:
                yield from self._consume_tag_char(ch)
            else:
                yield from self._consume_narr_char(ch)

    def flush(self) -> Iterator[dict]:
        """Called at end of stream. Emits any buffered narrative as a token event;
        drops any half-finished tag silently (it would just be an LLM truncation).
        """
        if self._narr_pending:
            yield {"event": "token", "text": self._narr_pending}
            self._narr_pending = ""
        if self._buf:
            yield {"event": "token", "text": "".join(self._buf)}
            self._buf.clear()

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
            if parsed is not None:
                yield {"event": "primitive", "tag": parsed}
            else:
                # malformed; emit as text so we don't silently lose content
                yield {"event": "token", "text": f"[{tag_text}]"}
            return
        if ch == "\n" and not self._in_quote:
            # Tag must be single-line. Treat newline mid-tag as abort -> narrative.
            text = "[" + "".join(self._tag_buf) + ch
            self._tag_buf = []
            self._in_tag = False
            yield {"event": "token", "text": text}
            return
        self._tag_buf.append(ch)

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
