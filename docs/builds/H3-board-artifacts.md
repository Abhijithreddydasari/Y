# H3: Board artifacts, plus the tutor model and voice picker

Status: done, 2026-11-02 (see the [H3 handoff](../handoffs/H3.md); "As built" notes below mark where it differs). Branch `feature/board-artifacts`, cut from `main` at `65b44d4` (H1 and
H2 merged). Prerequisites: H1 ([handoff](../handoffs/H1.md)), H2 ([handoff](../handoffs/H2.md)).

## Learner story

I ask how attention works. Y writes the idea, draws a small flowchart of query, key, value and
softmax as ordinary board shapes I can move, and then puts a live attention widget on the board:
the tokens of a sentence, a heatmap of who attends to whom and a temperature slider. Dragging the
slider changes the weights at once, with no waiting. Later an illustration fades in beside the
lesson. When I pan, zoom or refresh, everything stays where it was, and my pen still writes over
the widget. In the corner I can pick the tutor model and voice, as in a chat app, and see which
model answered each turn.

## What exists and what H1/H2 left

- H0's contract already has `diagram {mermaid}`, `widget {kind, spec}` with `PlotSpec`,
  `AttentionSpec`, `MatrixSpec`, `StepperSpec`, and `image {prompt, alt}`. The validator parses
  widget specs. Nothing renders them.
- `tutor_turn.ENABLED` offers only seg/write/equation/say/predict/check/turn_end. With all kinds
  offered, the model emitted an unrequested `attention` widget. The prompt says these kinds are
  "not available".
- `moveToPrimitive` returns `null` for diagram, widget and image.
- Excalidraw 0.18.1 bundles `@excalidraw/mermaid-to-excalidraw` 2.2.2 (mermaid 11.17.2 via the
  existing override). Excalidraw exposes `convertToExcalidrawElements`, `renderEmbeddable` and
  `validateEmbeddable`.
- The tutor model is fixed by `META_TUTOR_MODEL` (default `muse-spark-1.3`, `minimal`). The voice is
  `kokoro_af_heart` or `kokoro_am_michael` (the only two allowlisted in `api/speech.py`), with the
  browser voice as fallback. The legacy toolbar model choice (openai, edge, edge-ft, cloud) drives
  Teach, Practice and chat only.

## Decisions

1. **Diagrams.** The browser converts Mermaid with `parseMermaidToExcalidraw` and
   `convertToExcalidrawElements`, lazy-loaded on the first diagram.
   - The output becomes native, editable elements (`creator: model`, `source: diagram`), grouped,
     scaled to at most the narration column's width and placed like any other primitive.
   - The server checks a diagram move cheaply before accepting it: the first line must be a
     supported type (`flowchart`/`graph`, `sequenceDiagram`, `classDiagram`), at most 30 nodes and
     4,000 characters, and no `click`, `href`, `call`, `%%{init` or HTML in labels. A failure gets
     H1's single repair.
   - If the browser parse still fails, the diagram's labels are written as a short text list in
     the same place, never a broken diagram. The failure is logged in the turn timing.
   - Mermaid runs with `securityLevel: "strict"` and no HTML labels.
2. **Widget host: spike embeddables first (time box 45 min).**
   - An embeddable element with `link: "y-widget://<id>"` and the widget's kind and validated spec
     in `customData`. `validateEmbeddable` accepts only that scheme. `renderEmbeddable` returns the
     React widget for it and `null` (Excalidraw's default) for everything else.
   - Pass criteria: follows pan and zoom, saves and restores with the board (the board store
     already keeps elements and `customData`), and a pen or freedraw stroke started over the widget
     goes to the canvas. The widget responds to pointer events only while the selection tool is
     active.
   - If any criterion fails, use an overlay layer instead: absolutely positioned from
     `scrollX`, `scrollY` and `zoom`, anchored to a locked placeholder rectangle that carries the
     same `customData`. `pointer-events: none` whenever a drawing tool is active.
   - The handoff records which one won and why.
3. **Widgets compute; the model only parameterises.** All maths is local, with no network and no
   `eval` or `Function`.
   - `plot`: a small expression parser (numbers, `x`, the spec's parameters, `+ - * / ^`, unary
     minus, parentheses, and the functions `sin cos tan exp log sqrt abs tanh` plus `pi`, `e`) is
     compiled to a closure tree once per spec. An unknown name rejects the spec. One slider per
     parameter. 200 samples per redraw, non-finite points break the line. The y range is fitted to
     the first draw and then held, so moving a slider visibly moves the curve.
   - `attention`: tokens plus temperature. Scores come from fixed toy embeddings: a hashed,
     seeded vector per token (d = 8) plus a position term, `softmax(q·k / (√d · T))`. The widget shows
     the heatmap with a selected query row, the temperature slider and a "divide by √d" toggle.
     A footnote says "toy embeddings", so it never claims real model weights.
   - P1: `matrix` (an editable grid that shows the determinant and the transform of the unit
     square for 2×2) and `stepper` (steps with KaTeX, previous and next).
   - The server's existing spec validation stays the gate. The browser validates again before it
     mounts and shows a quiet "widget could not load" placeholder otherwise.
4. **Images (P1): generated by the server, never requested by the browser.**
   - When the turn engine accepts an `image` move, it starts a background job (the prompt plus a
     fixed suffix asking for an illustration with minimal or no text), bounded to 2 at a time
     and 20 s. The public move gets an `image_id`.
   - `GET /learning/sessions/{sid}/images/{image_id}` returns `pending`, `ready` (with the board
     asset hash) or `failed`. The WebP goes through the existing board asset store, so it is
     content-addressed, owner-scoped and restored with the board.
   - The browser places a dashed placeholder with the alt text at once, polls every 1.5 s for up
     to 30 s, then swaps in an Excalidraw image element with `customData` provenance
     `{creator: "model", source: "muse-image-1.0", prompt, alt}`. On failure the placeholder becomes
     the alt text in italics. The lesson never waits for the image.
   - Budget: 10 images per owner per hour and 60 globally, through the tutor storage budget.
     A turn holds at most one image. A replayed turn reuses the stored job and never regenerates.
5. **Enabling the kinds, with a prompt that says when each one helps.**
   - `ENABLED` adds `diagram` and `widget`; `image` joins once its P1 path works. The narrowed
     schema stays.
   - The `moves` section explains each artifact in terms of when it earns its place:
     - a diagram for a process, a data flow or a structure with three or more parts;
     - a widget only when changing a number teaches something (a parameter's effect, temperature,
       scaling), at most one per turn, never as decoration;
     - an image only for a physical or visual idea that words and a diagram cannot show, at most
       one per turn, with no maths or labels in the image.
     The "not available" line keeps `point` and `because`.
   - Widget specs are taught with one example per kind, because the schema carries them as a
     JSON-encoded string.
6. **Model and voice picker.**
   - The server owns an allowlist in a new `api/learning/tutor_models.py`:
     - `muse-spark-1.3` at `minimal`: the default, "Balanced".
     - `muse-spark-1.3` at `low`: "Careful", labelled as about 2–3 s slower to its first move.
     - `muse-spark-1.2` at `minimal`: "Fast", labelled "quicker, less reliable on structured
       moves" (16 of 160 bad moves measured).
     - Muse Spark Open (`meta-models/muse-spark-open-1026` on Baseten): offered only if a quick live
       check of 5 move turns passes the strict schema with at most 1 bad move and a first move
       under 6 s. Otherwise it is left out and the handoff says why.
   - `GET /learning/tutor/options` returns models and voices, each with `available` and a
     `reason` (key not configured, engine not loaded).
     - Voices: Kokoro Heart and Michael, available when the speech engine is available. Browser
       voice is always available. Off is always available.
   - The turn body carries `model` (an option id). The server resolves the id against the
     allowlist, rejecting an unknown or unavailable one with 422 before any claim. The browser
     never sends a provider model name or base URL. The resolved model and effort go into the
     turn's stored timing and the `done` event, so the trace shows which model answered.
   - Storage: the choice is kept per learner in `localStorage` and re-validated against the
     options on load, so an option that has become unavailable falls back to the default. Each
     turn records what it used, so the session's history stays truthful.
   - UI: a compact pill in the composer ("Muse Spark 1.3 · Heart"). It opens a small popover with
     two groups, Tutor and Voice, each option with a one-line note and a disabled state with its
     reason. It is keyboard accessible and closes on Escape. It replaces nothing in the legacy
     toolbar, which keeps driving Teach, Practice and chat, but the tutor path ignores
     `modelChoice`. The mobile shell gets the same pill above the bottom bar.
   - A change takes effect on the next turn; a voice change during narration applies from the next
     clause (`switchSpeechVoice` already exists). Off equals the existing Narration toggle.

**As built** (details in the handoff):
- Embeddables won the spike; no overlay. Excalidraw keeps an embeddable's pointer events off
  until a centre click activates it, which made sliders awkward. Instead, only the widget's
  controls take pointer input, and only while the selection tool is active.
- The diagram check caps Mermaid at 40 statement lines rather than counting nodes. A
  left-to-right flowchart too wide for the column is re-laid top-down, and labels stay at 14 px
  or more.
- Spark Open passed only at `reasoning_effort: low`. Without an effort cap it spent the whole
  3,000-token budget reasoning in 4 of 5 turns.
- The image job's timeout is 25 s (live calls took 10–24 s). The browser polls for 45 s, then
  resumes polling on the next board load.

## Scope

- P0: diagrams, the widget host, `plot`, `attention`, enabled kinds and prompt, the picker,
  tests, live validity run, browser journey.
- P1, in this order if time allows: `image`, `matrix`, `stepper`.

Exclude:
- model-written JavaScript, HTML or sandboxed simulations (deferred);
- `point` and `because` (H8, H5);
- editing a widget's spec from the board, or a widget answering a check;
- Mermaid types beyond the three listed;
- per-learner model choice on the server, or a model choice for legacy panels.

## Contract changes (H0 surface)

- No change to the move schema or the widget spec models. The public `image` move gains
  `image_id` (added by the server, like `qid`).
- `TurnBody` gains an optional `model` option id.
- New routes: `GET /learning/tutor/options` and `GET /learning/sessions/{sid}/images/{image_id}`.
  The proxy allows both.

## Failure, cancellation and recovery

- An invalid diagram or widget is repaired once on the server, else dropped. A client-side
  conversion failure degrades to text or the placeholder.
- Stop cancels the turn as before. An image job already started finishes and is stored (it is
  already paid for) but is only inserted if its placeholder is still on the board.
- A refresh restores diagrams and widgets from the saved board. A pending image placeholder
  resumes polling on load.
- Widgets never move or cover learner ink: they are placed by the existing layout like other
  primitives.

## Acceptance

1. An attention question produces an attention widget whose slider changes the weights locally,
   with no network request (checked in the network panel).
2. A process question produces a Mermaid diagram as native, editable Excalidraw elements.
3. Widgets follow pan and zoom, survive a refresh, and a pen stroke started over one draws on the
   board.
4. An image (P1) arrives later without blocking the turn. A failed image leaves the lesson intact.
5. Switching model and voice mid-session takes effect on the next turn and next clause; the turn
   records the model it used; unavailable options are disabled with a reason; refresh restores
   the choice.
6. An unknown model id from the browser is rejected before any paid call.

## Budgets and measurement

| Measure | Method | Target |
|---|---|---|
| Artifact validity | ~15 live turns written to call for diagrams and widgets, plus 5 that should not | Report valid, repaired and dropped; widgets appear only when they help |
| First move and turn time | Same runs, through the real route | First move p50 stays ≤ 3 s at `minimal` |
| Mermaid conversion | Browser timing from move to elements on the board | Report; first call includes the lazy load |
| Slider update | `performance.now()` around a redraw | ≤ 16 ms for 200 samples or a 12×12 grid |
| Muse Image | Job start → ready, 3–5 samples | Report (about 11 s expected) |
| Model comparison | 5 turns per offered model: first move, total, bad moves | Report honestly, labels follow the numbers |

## Tests and evidence

- **Backend (mocked provider):** diagram precheck (types, size, blocked directives); widget kinds
  enabled; the model allowlist (unknown id → 422 with no claim, unavailable → 422, resolved
  model in the trace); the options route with keys present and missing; the image job
  (ready, failed, timeout, budget, replay reuses the job, ownership on the image route).
- **Frontend:** move mapping for diagram, widget and image; Mermaid conversion with a stub and
  the text fallback; the expression evaluator (precedence, functions, unknown names rejected,
  no `eval`/`Function`); attention softmax rows sum to 1 and temperature sharpens; the widget
  host's tool gating; the picker (disabled reasons, persistence, fallback to default); image
  polling and placeholder swap.
- `tsc`, changed-file lint and build.
- **Live** (separate from mocked): the validity table, the model comparison, Muse Image timing.
- **Browser journey:** attention widget with a working slider, a Mermaid diagram, an image
  arriving later, switching model and voice mid-session, pan, zoom and refresh restore, and a pen
  stroke over a widget.
- Write `docs/handoffs/H3.md`, update the H3 row in Slice status, and make scoped commits (API,
  web, docs).

## Files

API:
- `api/learning/tutor_turn.py` (`ENABLED`, diagram precheck, image job start)
- new `api/learning/tutor_models.py` (allowlist and options)
- new `api/learning/image_jobs.py` (Muse Image client and job table)
- `api/learning/tutor_provider.py` (model, effort and base URL from the resolved option)
- `api/learning/tutor_router.py`, `api/prompts/tutor-v1.md` (moves section)
- `api/tests/test_board_artifacts.py`

Web:
- new `web/src/components/widgets/*` (host, `PlotWidget`, `AttentionWidget`, P1 widgets)
- new `web/src/lib/expr.ts`, `web/src/lib/mermaid-board.ts`
- `web/src/lib/renderer.ts` (registry hook), `web/src/lib/tutor-turn.ts`
- `web/src/components/Whiteboard.tsx` (embeddable props)
- new `web/src/components/TutorPicker.tsx`, `TutorComposer.tsx`, `useTutorSession.ts`
- the learning proxy route, `web/package.json` (`@excalidraw/mermaid-to-excalidraw` pinned to the
  bundled 2.2.2)
- tests
