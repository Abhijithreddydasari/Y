"""Quick unit tests for parser + validator. Run after edits to those files."""
from __future__ import annotations

import sys
import os

# allow running from repo root or api/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from parser import IncrementalTagParser
from validator import _sanitize_svg, validate_and_repair


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
        # Bare-header salvage: model writes [Title] X\n instead of [title: "X"].
        (
            '[Title] Newton\'s Second Law\n',
            [{"tag": "title", "args": {"text": "Newton's Second Law"}}],
            "bare header [Title] -> title",
        ),
        (
            '[Formula] a = F / m\n',
            [{"tag": "equation", "args": {"latex": "a = F / m", "align": "center"}}],
            "bare header [Formula] -> equation",
        ),
        (
            '[Step 1] Substitute values into formula\n',
            [{"tag": "text", "args": {"content": "Substitute values into formula"}}],
            "bare header [Step 1] -> text",
        ),
        (
            '[Description] We use Newton\'s Second Law.\n',
            [{"tag": "text", "args": {"content": "We use Newton's Second Law."}}],
            "bare header [Description] -> text",
        ),
        (
            '[Conclusion] The answer is 5 m/s squared.\n',
            [{"tag": "text", "args": {"content": "The answer is 5 m/s squared."}}],
            "bare header [Conclusion] -> text",
        ),
        (
            '[List] Force (F) = 10 N\n',
            [{"tag": "text", "args": {"content": "Force (F) = 10 N"}}],
            "bare header [List] -> text",
        ),
        # Auto-promotion: text that looks like math -> equation.
        (
            '[Text] a = F / m\n',
            [{"tag": "equation", "args": {"latex": "a = F / m", "align": "center"}}],
            "bare header [Text] with equation content -> equation auto-promote",
        ),
        (
            '[Text] a = 10 / 2\n',
            [{"tag": "equation", "args": {"latex": "a = 10 / 2", "align": "center"}}],
            "bare header [Text] with numeric equation -> equation auto-promote",
        ),
        (
            '[Text] a = 5 m/s^2\n',
            [{"tag": "equation", "args": {"latex": "a = 5 m/s^2", "align": "center"}}],
            "bare header [Text] with units equation -> equation auto-promote",
        ),
        (
            '[Text] We are given the following values:\n',
            [{"tag": "text", "args": {"content": "We are given the following values:"}}],
            "bare header [Text] with prose -> stays text (no promote)",
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
        # [draw] primitive: simple triangle with single-quoted SVG attrs.
        (
            "[draw: svg=\"<g stroke='#111' fill='none'><path d='M 50 250 L 200 50 L 350 250 Z'/></g>\" viewBox=\"0 0 400 300\" caption=\"Triangle\"]",
            [
                {
                    "tag": "draw",
                    "args": {
                        "svg": "<g stroke='#111' fill='none'><path d='M 50 250 L 200 50 L 350 250 Z'/></g>",
                        "viewBox": "0 0 400 300",
                        "w": 400.0,
                        "h": 300.0,
                        "caption": "Triangle",
                    },
                }
            ],
            "[draw] basic triangle",
        ),
        # Schema alias: the model wrote `code=` instead of `svg=`.
        (
            "[draw: code=\"<circle cx='10' cy='10' r='5'/>\" caption=\"dot\"]",
            [
                {
                    "tag": "draw",
                    "args": {
                        "svg": "<circle cx='10' cy='10' r='5'/>",
                        "viewBox": "0 0 400 300",
                        "w": 400.0,
                        "h": 300.0,
                        "caption": "dot",
                    },
                }
            ],
            "[draw] alias code -> svg",
        ),
        # [draw_part] block: raw path commands inside.
        (
            "[draw_part: name=\"triangle\"]\nM 50 250 L 200 50 L 350 250 Z\n[/draw_part]",
            [
                {
                    "tag": "draw_part",
                    "args": {
                        "name": "triangle",
                        "viewBox": "0 0 400 300",
                        "w": 400.0,
                        "h": 300.0,
                        "svg": '<path d="M 50 250 L 200 50 L 350 250 Z" stroke="#111" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
                    },
                }
            ],
            "[draw_part] basic raw path",
        ),
        # [draw_part] block: mixed path and <text> elements.
        (
            "[draw_part: name=\"benzene\"]\nM 200 80 L 280 130 L 280 220 L 200 270 L 120 220 L 120 130 Z\n<text x='195' y='75' font-size='14'>C</text>\n[/draw_part]",
            [
                {
                    "tag": "draw_part",
                    "args": {
                        "name": "benzene",
                        "viewBox": "0 0 400 300",
                        "w": 400.0,
                        "h": 300.0,
                        "svg": (
                            '<path d="M 200 80 L 280 130 L 280 220 L 200 270 L 120 220 L 120 130 Z" stroke="#111" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>\n'
                            "<text x='195' y='75' font-size='14'>C</text>"
                        ),
                    },
                }
            ],
            "[draw_part] mixed path + text element",
        ),
        # [draw_part] alias: model wrote `label=` instead of `name=`.
        (
            "[draw_part: label=\"x\"]\nM 0 0 L 10 10\n[/draw_part]",
            [
                {
                    "tag": "draw_part",
                    "args": {
                        "name": "x",
                        "viewBox": "0 0 400 300",
                        "w": 400.0,
                        "h": 300.0,
                        "svg": '<path d="M 0 0 L 10 10" stroke="#111" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
                    },
                }
            ],
            "[draw_part] alias label -> name",
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

    # Block primitive split across chunks (closing marker straddles a chunk boundary).
    p = IncrementalTagParser()
    out = []
    chunks = [
        "[draw_part: name=\"tri",
        "angle\"]\nM 0 0 L 10",
        " 10 Z\n[/draw_",
        "part]",
    ]
    for chunk in chunks:
        out.extend(list(p.feed(chunk)))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    validated = []
    for ev in prim:
        ok, t = validate_and_repair(ev["tag"])
        if ok:
            validated.append(t)
    if not assert_eq(
        validated,
        [{
            "tag": "draw_part",
            "args": {
                "name": "triangle",
                "viewBox": "0 0 400 300",
                "w": 400.0,
                "h": 300.0,
                "svg": '<path d="M 0 0 L 10 10 Z" stroke="#111" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
            },
        }],
        "draw_part block spanning chunks (close marker split)",
    ):
        failures += 1

    # Block primitive: half-finished (no closing marker) -> emit on flush with
    # whatever body was collected. We at least want a primitive event so the
    # frontend can show *something* of a partially-streamed diagram.
    p = IncrementalTagParser()
    out = []
    out.extend(list(p.feed("[draw_part: name=\"x\"]\nM 0 0 L 1 1\n")))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    if not assert_eq(
        [p["tag"]["tag"] for p in prim],
        ["draw_part"],
        "draw_part: missing close marker -> emit on flush",
    ):
        failures += 1

    # P2 hardening: draw_part body has 2 valid + 1 malformed path; validator
    # salvages the 2 and ships the diagram.
    p = IncrementalTagParser()
    out = []
    body = (
        "[draw_part: name=\"mixed quality\"]\n"
        "M 0 0 L 10 10\n"
        "999 999 NOT VALID PATH\n"   # rejected: no command letter
        "M 20 20 L 30 30\n"
        "[/draw_part]"
    )
    out.extend(list(p.feed(body)))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    salvage_ok = False
    if prim and prim[0]["tag"]["tag"] == "draw_part":
        ok, t = validate_and_repair(prim[0]["tag"])
        if ok:
            svg_inner = t["args"].get("svg", "")
            n_paths = svg_inner.count("<path ")
            salvage_ok = n_paths == 2
    if not assert_eq(salvage_ok, True, "draw_part: salvage 2 of 3 paths"):
        failures += 1

    # P2 hardening: draw_part with all-malformed body -> downgrade to text.
    p = IncrementalTagParser()
    out = []
    out.extend(list(p.feed("[draw_part: name=\"junk\"]\nthis is not path data\n[/draw_part]")))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    fallback_ok = False
    if prim:
        ok, t = validate_and_repair(prim[0]["tag"])
        fallback_ok = (not ok) and t["tag"] == "text"
    if not assert_eq(fallback_ok, True, "draw_part: all-junk body -> text fallback"):
        failures += 1

    # P2 hardening: draw_part rejects coordinates beyond hard cap.
    p = IncrementalTagParser()
    out = []
    out.extend(list(p.feed("[draw_part: name=\"huge\"]\nM 0 0 L 999999 999999\n[/draw_part]")))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    huge_ok = False
    if prim:
        ok, t = validate_and_repair(prim[0]["tag"])
        # No valid paths -> downgrade to text.
        huge_ok = (not ok) and t["tag"] == "text"
    if not assert_eq(huge_ok, True, "draw_part: hard-cap coords -> text fallback"):
        failures += 1

    # P2 hardening: draw_part rejects malformed XML element line.
    p = IncrementalTagParser()
    out = []
    body = (
        "[draw_part: name=\"bad xml\"]\n"
        "<text x='10' y='10'>missing close\n"  # rejected: no </text>
        "M 0 0 L 10 10\n"
        "[/draw_part]"
    )
    out.extend(list(p.feed(body)))
    out.extend(list(p.flush()))
    prim = [e for e in out if e["event"] == "primitive"]
    xml_ok = False
    if prim:
        ok, t = validate_and_repair(prim[0]["tag"])
        if ok:
            svg_inner = t["args"].get("svg", "")
            xml_ok = "<text" not in svg_inner and "<path" in svg_inner
    if not assert_eq(xml_ok, True, "draw_part: malformed XML element dropped, path kept"):
        failures += 1

    # SVG sanitizer: scripts, foreignObject, event handlers, javascript: URLs all stripped.
    sanitize_cases = [
        (
            "<g><script>alert(1)</script><path d='M 0 0'/></g>",
            "<g><path d='M 0 0'/></g>",
            "sanitize: <script> stripped",
        ),
        (
            "<foreignObject><div onclick='x()'>hi</div></foreignObject><circle cx='1' cy='1' r='1'/>",
            "<circle cx='1' cy='1' r='1'/>",
            "sanitize: <foreignObject> stripped",
        ),
        (
            "<path d='M 0 0' onclick='alert(1)' stroke='#111'/>",
            "<path d='M 0 0' stroke='#111'/>",
            "sanitize: onclick attr stripped",
        ),
        (
            "<a href=\"javascript:alert(1)\"><circle/></a>",
            "<a><circle/></a>",
            "sanitize: javascript: URL stripped",
        ),
        (
            "<image href='https://evil.example/x.png'/>",
            "",
            "sanitize: <image> void element stripped",
        ),
    ]
    for raw, want, label in sanitize_cases:
        got = _sanitize_svg(raw)
        if not assert_eq(got, want, label):
            failures += 1

    print()
    print(f"{'PASS' if failures == 0 else 'FAIL'} ({failures} failures)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
