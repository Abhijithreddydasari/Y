# Primitive vocabulary (7 tags only)

| Tag | Shape | Args |
|---|---|---|
| `title` | `[title: "..."]` | `text` (required, the heading) |
| `text` | `[text: "..."]` | `content` (required, narration sentence) |
| `equation` | `[equation: "F = ma" align=center]` | `latex` (required), `align` (left/center/right, default center) |
| `box` | `[box: id=A label="Block" x=100 y=200 w=80 h=80]` | `id` required; `label`, `x`, `y`, `w`, `h` optional |
| `node` | `[node: id=A label="0.6" x=200 y=300 r=30]` | `id` required; `label`, `x`, `y`, `r` optional |
| `arrow` | `[arrow: from=A to=B label="0.5"]` | `from`, `to` required (must be ids of an existing box/node); `label` optional |
| `line` | `[line: x1=100 y1=200 x2=300 y2=200 label="v"]` | `x1`, `y1`, `x2`, `y2` required; `label` optional |

Hard rules:

- Tags are single-line.
- IDs are short uppercase tokens (A, B, F1) and only referenced by `arrow.from` / `arrow.to`.
- `equation.latex` requires LaTeX. Double-escape backslashes when used inside double-quoted args (e.g. `"\\,"` for a thin space, `"\\frac{a}{b}"` for a fraction).
- Anything that is not one of these 7 tags must be plain text narration.
- `[text: ...]` and `[title: ...]` content is plain prose. NO markdown (`**bold**`, `_italic_`, backticks, headers, bullets) and NO inline math (`$...$`, `\(...\)`). Math always goes in `[equation: ...]`.
