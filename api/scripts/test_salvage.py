"""Quick tests for the salvage module."""
from __future__ import annotations

import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from salvage import salvage_raw_to_primitives


def main() -> int:
    failures = 0

    # Test 1: JSON vision detection blob (gemma4:e4b sometimes emits this)
    blob = json.dumps([{
        "box_2d": [0, 0, 999, 999],
        "text_content": (
            "Title: Physics Problem Solving\n\n"
            "Problem: F = m * a\n\n"
            "Given:\n\n"
            "*   Force (F) = 10 N\n"
            "*   Mass (m) = 2 kg\n\n"
            "Find: a\n\n"
            "Solution:\n\n"
            "1.  Write the formula: a = F / m\n"
            "2.  Substitute: a = 10 / 2\n"
            "3.  Calculate: a = 5 m/s^2\n\n"
            "Answer: a = 5 m/s^2"
        ),
    }])
    r1 = salvage_raw_to_primitives(blob)
    print(f"Test 1 (JSON blob): {len(r1)} primitives")
    for p in r1:
        print(f"  {p['tag']}: {p['args']}")
    if len(r1) < 3:
        print("  FAIL: expected >= 3 primitives")
        failures += 1
    else:
        print("  OK")

    # Test 2: Plain markdown text
    md = (
        "# Newton's Second Law\n\n"
        "Given: m = 2 kg, F = 10 N\n\n"
        "1. Write the formula: F = m * a\n"
        "2. Rearrange: a = F / m\n"
        "3. Substitute: a = 10 / 2\n"
        "4. Result: a = 5 m/s^2\n\n"
        "The acceleration is 5 meters per second squared.\n"
    )
    r2 = salvage_raw_to_primitives(md)
    print(f"\nTest 2 (Markdown): {len(r2)} primitives")
    for p in r2:
        print(f"  {p['tag']}: {p['args']}")
    if len(r2) < 3:
        print("  FAIL: expected >= 3 primitives")
        failures += 1
    else:
        print("  OK")

    # Test 3: Empty
    r3 = salvage_raw_to_primitives("")
    print(f"\nTest 3 (Empty): {len(r3)} primitives")
    if len(r3) != 0:
        print("  FAIL: expected 0")
        failures += 1
    else:
        print("  OK")

    # Test 4: Bare bracket-header text (already handled by parser, but
    # test salvage in case parser also fails).
    bare = (
        "[Title] Newton's Second Law\n"
        "[Description] We use F = m * a\n"
        "[Formula] a = F / m\n"
        "[Step 1] Substitute values\n"
        "[Conclusion] The answer is 5 m/s^2\n"
    )
    r4 = salvage_raw_to_primitives(bare)
    print(f"\nTest 4 (Bare headers): {len(r4)} primitives")
    for p in r4:
        print(f"  {p['tag']}: {p['args']}")
    if len(r4) < 3:
        print("  FAIL: expected >= 3 primitives")
        failures += 1
    else:
        print("  OK")

    print()
    print(f"{'PASS' if failures == 0 else 'FAIL'} ({failures} failures)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
