# H8 brief: pointing, trace drawer, UI polish

Status: built, 2026-11-03 (as built and measured: [H8 handoff](../handoffs/H8.md); the Trace pill moved into the composer row, and rings use the whole snapped line). Branch `feature/pointing-polish`, cut from `main` at `2029ff3` (H7 merged).
Priority P1. Cut from the bottom of the scope list. H9 (deploy) follows and is never cut, so
feature work stops at about 18:30 IST to leave time for it.

## Learner story

A learner writes `3x + 5 = 20 / 3x = 25 / x = 25/3` in ink and asks "Is my working right?". Y draws
a ring around `3x = 25` on their own work, labelled "20 − 5 is 15", then explains beside it. Their
ink never moves and is never covered. A judge opens a small **Trace** drawer and sees which model
did each step and how long each stage took.

## Acceptance scenarios

1. **Point on ink.** With learner ink in the focus crop, a turn can emit `point`. The ring lands on
   the ink group of the reported line. Rings are stroke-only (no fill), padded outside the group's
   box, and created by `model`. Learner elements are unchanged (same version and position).
2. **No crop, no point.** Without an ink crop (blank board, typed text only), `point` is not offered
   in the schema for that turn. A stray one is dropped without a repair call.
3. **Replay and refresh.** The resolved ring position is stored in the move, so a replay or refresh
   shows the same ring without a model call.
4. **Live hit rate.** At least 10 live turns on learner-style ink with a planted error. Report:
   - raw-point hits;
   - snapped hits (ring box contains the error group);
   - wrong-line picks.

   Target: the snapped hit rate is above the raw rate (the decisions log measured 11/18 raw).
5. **Trace drawer.** It is opt-in: a small "Trace" pill in Studio and an item in More on Mobile.
   It lists this session's stages, newest first:
   - tutor turns: model, effort, first move, total, provider first token, tokens, dropped moves and
     repairs, and point snap results;
   - the browser's own first render and first audio for the latest turn;
   - hints: level, ms, model;
   - evidence labels: labeler, `provider_ms`, `queue_ms`, `label_ms`, failures;
   - close: total ms, the notes model and `notes_trace` (kept, dropped, named, links, error).

   It closes with Escape and makes no request until it is opened.
6. **Polish.**
   - Glass chrome: one `.y-glass` style on the toolbar, composer, pills, question card and drawer.
   - Equations, ink and widget surfaces stay opaque.
   - With reduced motion, transitions and animations are off.
   - Drawing a stroke over the board while chrome is visible gives no frame drops (frame-time
     probe while drawing: p95 ≤ 20 ms on this laptop, with and without glass).
7. **Small fixes.**
   - Mind concept labels keep the casing used in the learner's questions ("FFN role", not
     "Ffn role").
   - A canvas whose first turn was a review is titled from the review's question, not "Untitled
     canvas".
   - Optional and cut first: an answer turn's feedback starts under the answered card when the
     space there is free.

## Design

### `point` (server: `tutor_turn.py`, new `pointing.py`, `tutor_router.py`, prompt)

- **Enabling `point`.** Add `point` to `ENABLED`, with at most 2 per turn. `MetaTutor` sends
  `response_format(ENABLED)` when the turn has at least one image, and `ENABLED − {point}`
  otherwise. Both formats are prebuilt constants, so the prefix cache is unaffected. The
  validator's existing crop-index check remains, and a crop error is no-repair.
- **Prompt.** Replace the "Not available" line in `tutor-v1.md` with a short `point` rule:
  - only on learner ink shown in an image;
  - `crop` is the image index;
  - `x` and `y` run 0–1000 over that image;
  - `line` is the 1-based line of the learner's work, top to bottom;
  - `label` is at most about 6 words;
  - emit it before the write that explains it;
  - never point at the tutor's own output.
- **Resolution** (`pointing.resolve(move, crop, focused)`, pure, no model call):
  1. Map to board coordinates: `bx = crop.x + x/1000 · crop.w`, `by = crop.y + y/1000 · crop.h`.
     The crop bounds already include the 24 px export padding.
  2. Take the human, visual elements in `crop.element_ids` and their bounds from the packet.
  3. **Lines:** sort by centre y, then join a stroke to the current line when its vertical
     overlap with the line is at least 40% of the smaller height. This is O(n log n) and capped at
     200 elements.
  4. **Groups in a line:** split where the horizontal gap exceeds 1.2 × the line's median stroke
     height.
  5. Pick the line:
     - the reported `line` when it is 1 to the line count (`snap: "line"`);
     - otherwise the line containing `by`, or the nearest one (`snap: "nearest"`).

     Within the line, pick the group nearest `bx`.
  6. If the model's `line` disagrees with the line under the raw point, the reported line wins.
     The measurements say the skew is in y.
  7. Output `at: {x, y, w, h}` (the group box plus 10 px padding), `raw: {x, y}`, `snap`, and
     `line_count`.
  8. With no human ink in the crop, use `snap: "raw"`: a 60 px ring at the raw point.
- **Storage.** The router resolves a point as it streams, the same way it does for `image`, and
  writes `at`, `raw` and `snap` into the stored and public move. A replay therefore needs nothing
  new. `summary()` records `points: [{snap, line}]` for the trace.

### `point` (web: `tutor-turn.ts`, `useTutorSession.ts`, new `board-pointing.ts`)

- `PublicMove` gains `point` with `at`, `label` and `snap`.
- `board-pointing.ts` builds an Excalidraw ellipse:
  - stroke 2.5 px, warm accent `#e8590c`, transparent fill, `roughness: 1`;
  - `customData.ySemantic = {kind: "point"}`, so the board reader skips it;
  - a short label text above or right of the ellipse, placed outside the group box, never on ink.
- It is appended directly through the handle as `model`, not through the layout cursor. The
  area check exempts elements tagged `ySemantic.kind === "point"`, because a ring belongs on the
  learner's work, not in the response area.
- The ring is drawn as soon as the move arrives, before the explanation that follows it. With
  reduced motion it simply appears.

### Trace drawer (`GET /learning/sessions/{sid}/trace`, `TraceDrawer.tsx`)

- **One owner-scoped route** reads existing data only:
  - `learning_tutor_turns.timing` (per turn);
  - `learning_hints.timing`;
  - evidence rows (`label_ms`, `provider_ms`, `queue_ms`, labeler, error);
  - the sealed close summary (`ms`, `notes_trace`).

  It returns compact rows of at most 40 turns, with no texts beyond the turn's first segment goal.
  No keys or prompts are included. The proxy allowlist gains `sessions/<id>/trace`.
- **Client stages.** The hook exposes the latest `timing` it already measures (`first_move_ms`,
  `first_render_ms`, `first_audio_ms`, `drawn_ms`), and the drawer shows it beside the server row.
- **UI.** The drawer is a right-side glass sheet, 360 px, lazy-loaded with `next/dynamic`. Each
  stage is one row: a model badge (Spark 1.3 · minimal, OpenAI Decisions `gpt-6-luna`, Spark Open)
  plus a thin latency bar on a shared scale. It refreshes when opened and after each turn while
  open. There are no charts libraries and no polling.

### Polish (`globals.css`, shells, toolbar, composer, cards)

- **One glass style.** `.y-glass` is `rgba(255,255,255,.72)` with `backdrop-filter: blur(12px)
  saturate(1.2)`, a hairline border and a soft shadow. It applies only to small, fixed chrome, never
  to a full-screen layer.
  - With `@supports not (backdrop-filter)`, fall back to an opaque background.
  - With `prefers-reduced-transparency`, use an opaque background.
- **Opaque surfaces.** Widget hosts, KaTeX and the board stay opaque, so blur never sits under ink
  that is being drawn.
- **Motion.** A global reduced-motion rule turns transitions and animations off (it extends the
  existing blocks).
- **Measurement.** A `?fps=1` frame-time probe while pointer-drawing 3 s strokes, with glass on and
  off. If glass costs more than 2 ms at p95, chrome over the canvas falls back to an opaque
  surface.

### Small fixes

- **Concept labels.** `conceptLabel(concept, texts)` re-cases each id token with the casing found
  in that concept's question texts from the existing `events` digest (`ffn` → `FFN`). Without a
  match, it keeps today's label.
- **Canvas titles.** `StudyStore.canvases` falls back to the first review's question
  (`Warm-up: <q>`), then the exit concept, then "Untitled canvas".
- **Feedback placement** (optional). For an answer turn, use an origin under the answered card's
  frame when the 900 × 600 area below it holds no other element. Otherwise keep `response_area`.

## Exclusions

- No new model calls or providers.
- No pointing on typed or native text: it has no crop, so its ids are already in the packet.
- No editing of learner ink, and no persistence of widget state.
- No Postgres-specific work.
- No change to answer grading or the learner model.

## Contracts

- `tutor_moves.Point` is unchanged, and so is `schema/tutor-moves.v1.json`.
- Stored and public `point` moves gain `at`, `raw` and `snap` (added by the server, like `image_id`).
- New route `GET …/trace`.
- `MetaTutor.stream` takes an optional per-turn format.
- All of these will be noted in the handoff.

## Failure, ownership, recovery

- The trace route goes through `require_owner`. Another owner's session returns the same 404 as
  the other routes.
- A point that cannot be resolved still renders as a raw ring. It never blocks or reorders the turn.
- Stop cancels remaining moves as before. A ring already drawn stays, like any drawn move.

## Tests

- **Mocked backend:**
  - line and group clustering (slanted lines, a 2-stroke `=`, single-stroke lines);
  - reported line vs raw-y disagreement;
  - out-of-range line;
  - no ink → raw;
  - crop mapping arithmetic;
  - `point` absent from the schema with no images;
  - a stray point with no crops dropped without repair;
  - resolved fields stored and replayed;
  - the trace route's shape, ownership and absence of secrets;
  - the canvas title fallback.
- **Mocked frontend:**
  - ring element geometry (outside the group, no fill, `model`, semantic tag);
  - the area-check exemption;
  - point mapping in `moveToPrimitive` and the hook;
  - the drawer rendering rows from a fixture, Escape, and lazy fetch;
  - concept re-casing.
- **Live** (paid, labelled live): `api/scripts/live_pointing.py`.
  - Synthetic learner-style ink: jittered single-stroke glyphs for digits, `x`, `+`, `−`, `=`,
    `/`, at handwriting size.
  - 3–4 problems with one planted error each, rendered to a crop the way the board exports it.
  - Runs the real `TurnRun` and `resolve` code, at least 10 turns, and reports raw, snapped and
    line hits and first-move latency.
- **Browser** (in-app):
  - the same ink inserted on the board;
  - ask → ring on the error line, with the ink unchanged;
  - the trace drawer in Studio and Mobile;
  - reduced-motion emulation;
  - the frame-time probe.
- **Full suites:** backend pytest, `npm test`, tsc, changed-file lint, build.

## Completion

`docs/handoffs/H8.md`, the slice status row, and scoped commits (api, web, docs). No push, no PR.
