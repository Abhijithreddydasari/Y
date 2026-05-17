# Primitive vocabulary (8 tags only)

| Tag | Shape | Args |
|---|---|---|
| `title` | `[title: "..."]` | `text` (required, the heading) |
| `text` | `[text: "..."]` | `content` (required, narration sentence) |
| `equation` | `[equation: "F = ma" align=center]` | `latex` (required), `align` (left/center/right, default center) |
| `box` | `[box: id=A label="Block" x=100 y=200 w=80 h=80]` | `id` required; `label`, `x`, `y`, `w`, `h` optional |
| `node` | `[node: id=A label="0.6" x=200 y=300 r=30]` | `id` required; `label`, `x`, `y`, `r` optional |
| `arrow` | `[arrow: from=A to=B label="0.5"]` | `from`, `to` required (must be ids of an existing box/node); `label` optional |
| `line` | `[line: x1=100 y1=200 x2=300 y2=200 label="v"]` | `x1`, `y1`, `x2`, `y2` required; `label` optional |
| `draw` | `[draw: svg="..." viewBox="0 0 400 300" caption="..."]` | `svg` required (inner SVG markup), `viewBox` (default `0 0 400 300`), `w`, `h`, `caption` optional |

Hard rules:

- Tags are single-line.
- IDs are short uppercase tokens (A, B, F1) and only referenced by `arrow.from` / `arrow.to`.
- `equation.latex` requires LaTeX. Double-escape backslashes when used inside double-quoted args (e.g. `"\\,"` for a thin space, `"\\frac{a}{b}"` for a fraction).
- Anything that is not one of these 8 tags must be plain text narration.
- `[text: ...]` and `[title: ...]` content is plain prose. NO markdown (`**bold**`, `_italic_`, backticks, headers, bullets) and NO inline math (`$...$`, `\(...\)`). Math always goes in `[equation: ...]`.

# `[draw: ...]` rules (the SVG escape hatch)

Use `[draw: ...]` ONLY for diagrams the simpler primitives can't express: chemistry structures (benzene rings, electron orbitals), biology (cells, organs, DNA), geometry constructions (triangles with labelled angles, circles with chords), circuits, free-body diagrams with multiple labelled forces, custom plots.

- Always quote `svg="..."` with double quotes. INSIDE the SVG, ALWAYS use single quotes for attributes: `<path d='M 0 0 L 100 100' stroke='#111' fill='none'/>`.
- Allowed SVG elements: `<g>`, `<path>`, `<circle>`, `<rect>`, `<line>`, `<polyline>`, `<polygon>`, `<ellipse>`, `<text>`, `<tspan>`, `<defs>`, `<marker>`, `<title>`. Anything else is stripped server-side.
- DO NOT use: `<script>`, `<foreignObject>`, `<iframe>`, `<image>`, `<use>`, event handlers (`onclick=...`), or `javascript:` URLs.
- Default coordinate system is `viewBox='0 0 400 300'` (width 400, height 300). Scale your shapes accordingly.
- Use `stroke='#111111'` and `fill='none'` for line drawings; the canvas background is white.
- `font-family='Virgil'` matches the Excalidraw aesthetic for any `<text>` elements.
- Always include a `caption="..."` so the diagram has a one-line label below it.
- Keep the markup small — one concept per `[draw]`. If two diagrams are needed, emit two tags.
