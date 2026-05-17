"""Unit tests for teacher.py JSON salvage paths.

Run from api/:
    .\\.venv\\Scripts\\python.exe scripts\\test_teacher.py
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from teacher import _parse_educator_json


def assert_eq(got, want, msg: str) -> bool:
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
        # Plain JSON.
        (
            '{"misconceptions":["a","b"],"follow_ups":["c"],"prereqs":["d"],"difficulty":"intermediate"}',
            {"misconceptions": ["a", "b"], "follow_ups": ["c"], "prereqs": ["d"], "difficulty": "intermediate"},
            "plain JSON",
        ),
        # Code-fenced JSON (the model wraps in ```json ... ```).
        (
            "```json\n{\"misconceptions\":[],\"follow_ups\":[\"x\"],\"prereqs\":[],\"difficulty\":\"introductory\"}\n```",
            {"misconceptions": [], "follow_ups": ["x"], "prereqs": [], "difficulty": "introductory"},
            "code-fenced JSON",
        ),
        # JSON wrapped in chatty text on either side.
        (
            'Sure! Here are the educator notes:\n{"misconceptions":["foo"],"follow_ups":[],"prereqs":[],"difficulty":"advanced"}\nLet me know.',
            {"misconceptions": ["foo"], "follow_ups": [], "prereqs": [], "difficulty": "advanced"},
            "JSON inside chatty wrapper",
        ),
        # Aliased keys (follow_up_questions / prerequisites).
        (
            '{"misconceptions":[],"follow_up_questions":["q"],"prerequisites":["p"],"difficulty":""}',
            {"misconceptions": [], "follow_ups": ["q"], "prereqs": ["p"], "difficulty": ""},
            "aliased keys (follow_up_questions, prerequisites)",
        ),
        # Pure garbage -> empty fallback.
        (
            "i have no JSON for you sorry",
            {"misconceptions": [], "follow_ups": [], "prereqs": [], "difficulty": ""},
            "garbage -> empty fallback",
        ),
        # Empty input.
        (
            "",
            {"misconceptions": [], "follow_ups": [], "prereqs": [], "difficulty": ""},
            "empty -> empty fallback",
        ),
        # String values where lists are expected -> wrapped to single-item list.
        (
            '{"misconceptions":"single","follow_ups":[],"prereqs":[],"difficulty":"x"}',
            {"misconceptions": ["single"], "follow_ups": [], "prereqs": [], "difficulty": "x"},
            "string value coerced to single-item list",
        ),
    ]
    for raw, want, label in cases:
        got = _parse_educator_json(raw)
        if not assert_eq(got, want, label):
            failures += 1

    print()
    print(f"{'PASS' if failures == 0 else 'FAIL'} ({failures} failures)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
