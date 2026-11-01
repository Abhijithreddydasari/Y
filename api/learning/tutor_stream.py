"""Incremental parser for a streamed `{"moves": [...]}` document.

Emits each array element as soon as its object closes, so the first move can render while the
rest of the turn is still streaming. String state (quotes, backslash escapes) survives chunk
boundaries; structural scanning jumps between special characters instead of walking every one.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

_STRUCT = re.compile(r'["{}\[\]]')
_IN_STRING = re.compile(r'["\\]')
_SEPARATORS = " \t\r\n,"


class MoveSyntaxError(ValueError):
    """The document cannot yield further moves; already emitted moves stay valid."""


@dataclass(frozen=True, slots=True)
class ParsedElement:
    index: int
    raw: str
    value: dict | None
    error: str | None = None


class MoveStreamParser:
    __slots__ = ("key", "max_chars", "max_elements", "_depth", "_in_str", "_esc", "_array", "_done",
                 "_closed", "_parts", "_size", "_key", "_last_key", "_count")

    def __init__(self, key: str = "moves", max_chars: int = 16_000, max_elements: int = 64):
        self.key, self.max_chars, self.max_elements = key, max_chars, max_elements
        self._depth = 0
        self._in_str = self._esc = False
        self._array = self._done = self._closed = False
        self._parts: list[str] | None = None  # current element text, across chunks
        self._size = 0
        self._key: list[str] | None = None  # current top-level key text
        self._last_key: str | None = None
        self._count = 0

    def feed(self, chunk: str) -> list[ParsedElement]:
        out: list[ParsedElement] = []
        pos, end = 0, len(chunk)
        start = 0 if self._parts is not None else -1
        key_start = 0 if self._key is not None else -1
        while pos < end:
            if self._in_str:
                if self._esc:
                    self._esc, pos = False, pos + 1
                    continue
                match = _IN_STRING.search(chunk, pos)
                if match is None:
                    break
                pos = match.end()
                if match.group() == "\\":
                    self._esc = True
                    continue
                self._in_str = False
                if key_start >= 0:
                    self._key.append(chunk[key_start:pos - 1])
                    self._last_key, self._key, key_start = "".join(self._key), None, -1
                continue
            match = _STRUCT.search(chunk, pos)
            gap = chunk[pos:match.start() if match else end]
            if gap.strip(_SEPARATORS) and (self._closed or (self._array and self._depth == 2)):
                raise MoveSyntaxError("trailing content after turn" if self._closed else "moves must be objects")
            if match is None:
                break
            char, pos = match.group(), match.end()
            if self._closed:
                raise MoveSyntaxError("trailing content after turn")
            if char == '"':
                self._in_str = True
                if self._array and self._depth == 2:
                    raise MoveSyntaxError("moves must be objects")
                if self._depth == 1:
                    self._key, key_start = [], pos
            elif char in "{[":
                if self._depth == 0 and char != "{":
                    raise MoveSyntaxError("turn must be a JSON object")
                if self._depth == 1 and char == "[" and self._last_key == self.key and not self._done:
                    self._array = True
                elif self._array and self._depth == 2:
                    if char != "{":
                        raise MoveSyntaxError("moves must be objects")
                    self._parts, self._size, start = [], 0, match.start()
                self._depth += 1
            else:
                self._depth -= 1
                if self._depth < 0:
                    raise MoveSyntaxError("unbalanced turn document")
                if self._parts is not None and self._depth == 2:
                    self._parts.append(chunk[start:pos])
                    out.append(self._element("".join(self._parts)))
                    self._parts, start = None, -1
                elif self._array and self._depth == 1:
                    self._array, self._done = False, True
                elif self._depth == 0:
                    self._closed = True
        if self._parts is not None:
            self._parts.append(chunk[start:])
            self._size += end - start
            if self._size > self.max_chars:
                raise MoveSyntaxError("move exceeds size limit")
        if self._key is not None:
            self._key.append(chunk[key_start:])
        return out

    def _element(self, raw: str) -> ParsedElement:
        index, self._count = self._count, self._count + 1
        if self._count > self.max_elements:
            raise MoveSyntaxError("turn exceeds move limit")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            return ParsedElement(index, raw, None, f"invalid JSON: {error.msg}")
        return ParsedElement(index, raw, value)

    def close(self) -> None:
        """Call after the stream ends; raises if the document was cut off."""
        if not self._done:
            raise MoveSyntaxError(f"missing or unterminated {self.key} array")
        if not self._closed:
            raise MoveSyntaxError("incomplete turn document")
