"""Quick unit tests for parser + validator. Run after edits to those files."""
from __future__ import annotations

import sys
import os

# allow running from repo root or api/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from parser import IncrementalTagParser
from validator import validate_and_repair


def parse_one(text: str) -> list[dict]:
    p = IncrementalTagParser()
    return list(p.feed(text)) + list(p.flush())


def assert_eq(got, want, msg: str):
    if got != want:
        print(f"FAIL: {msg}")
        print(f"  got:  {got}")
        print(f"  want: {want}")
        return False
    print(f"OK:   {msg}")
    return True


def main() -> int:
    failures = 0
    cases = [
        # (input, want_validated_primitives, label)
        (
            '[title: "Newton\'s Second Law"]',
            [{"tag": "title", "args": {"text": "Newton's Second Law"}}],
            "positional quoted -> title.text",
        ),
        (
            '[text: "Hello world"]',
            [{"tag": "text", "args": {"content": "Hello world"}}],
            "positional quoted -> text.content",
        ),
        (
            '[equation: "a = F / m"]',
            [{"tag": "equation", "args": {"latex": "a = F / m", "align": "center"}}],
            "positional quoted -> equation.latex w/ default align",
        ),
        (
            '[equation: "F = m \\\\cdot a"]',
            [{"tag": "equation", "args": {"latex": "F = m \\cdot a", "align": "center"}}],
            "LaTeX backslash unescape (\\\\cdot -> \\cdot)",
        ),
        (
            '[equation: "a = 5 \\\\, m/s^2"]',
            [{"tag": "equation", "args": {"latex": "a = 5 \\, m/s^2", "align": "center"}}],
            "LaTeX thin space unescape (\\\\, -> \\,)",
        ),
        (
            "[equation: F=ma]",
            [{"tag": "equation", "args": {"latex": "F=ma", "align": "center"}}],
            "unquoted unkeyed -> equation.latex salvage",
        ),
        (
            "[equation: a = 5 m/s^2]",
            [{"tag": "equation", "args": {"latex": "a = 5 m/s^2", "align": "center"}}],
            "unquoted with = inside -> equation.latex salvage",
        ),
        (
            "[box: id=A label=\"Block\" w=80]",
            [{"tag": "box", "args": {"id": "A", "label": "Block", "w": 80.0, "h": 60.0}}],
            "box keyed args with defaults",
        ),
        (
            "[arrow: from=A to=B label=push]",
            [{"tag": "arrow", "args": {"from": "A", "to": "B", "label": "push"}}],
            "arrow bareword label",
        ),
        (
            '[heading: "Recap"]',
            [{"tag": "title", "args": {"text": "Recap"}}],
            "alias heading -> title",
        ),
        (
            '[say: "great"]',
            [{"tag": "text", "args": {"content": "great"}}],
            "alias say -> text",
        ),
        (
            "[eq: \"F = m a\"]",
            [{"tag": "equation", "args": {"latex": "F = m a", "align": "center"}}],
            "alias eq -> equation",
        ),
        # Single-backslash LaTeX (model forgot to double-escape): backslash
        # must survive so KaTeX receives a valid command.
        (
            '[equation: "\\frac{u^3}{3} - u"]',
            [{"tag": "equation", "args": {"latex": "\\frac{u^3}{3} - u", "align": "center"}}],
            "single-backslash LaTeX preserved (\\frac)",
        ),
        (
            '[equation: "\\int_0^\\pi \\cos x \\, dx"]',
            [{"tag": "equation", "args": {"latex": "\\int_0^\\pi \\cos x \\, dx", "align": "center"}}],
            "single-backslash LaTeX preserved (\\int, \\pi, \\cos)",
        ),
    ]

    for raw, want, label in cases:
        events = parse_one(raw)
        prims_in = [e["tag"] for e in events if e["event"] == "primitive"]
        validated = []
        for p in prims_in:
            ok, t = validate_and_repair(p)
            if ok:
                validated.append(t)
        if not assert_eq(validated, want, label):
            failures += 1

    # Chunked streaming case: tag split across multiple feed() calls.
    p = IncrementalTagParser()
    out = []
    for chunk in ["[title: \"Newt", "on's", " Second Law\"]"]:
        out.extend(list(p.feed(chunk)))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    if not assert_eq(
        [(p["tag"]["tag"], p["tag"]["args"]) for p in prim],
        [("title", {"text": "Newton's Second Law"})],
        "tag spanning chunks",
    ):
        failures += 1

    print()
    print(f"{'PASS' if failures == 0 else 'FAIL'} ({failures} failures)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
