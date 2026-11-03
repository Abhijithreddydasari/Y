# H8 follow-up: board UI redesign (home is the board)

Status: done, 2026-11-03. Branch `feature/board-ui`, cut from `feature/pointing-polish` (H8). No push, no PR.
The design was agreed on the "Y board UI concepts" canvas (https://claude.ai/artifact/8DH6VE54YxWugXHmmbKzSf).
The Mind page was left as it is, on request, for a later pass.

## What changed for a learner

- **The board is the home screen.** A glass **Y** button in the bottom-right corner fans out a Places arc:
  - Mind;
  - Canvases;
  - Review, with a count of due checks;
  - End session;
  - Trace;
  - Settings.

  Hover or keyboard focus lifts a place outward along the arc and shows its name and hint. Escape or a press
  outside closes it, and a press outside never draws on the board. On Mobile the Y button sits in the bottom
  bar and fans upwards.
- **Tool dock.** A glass dock at the top centre replaces Excalidraw's toolbar: Select, Move, Pen, Highlighter,
  Eraser, Text, Shape, Arrow, plus five ink colours. It drives Excalidraw's own tools, so shortcuts (V, P, E…)
  still work and the dock follows them. Studio only; Mobile keeps Excalidraw's touch toolbar.
- **Question card.**
  - Options are full-width rows with a letter key.
  - "How sure?" is Guessing / Fairly sure / Certain, sent as 30 / 65 / 95 %.
  - Dots show the hints used.
  - Hint, Just tell me and the mic sit on a footer row.
- **Canvases** is a searchable grid with an All / Open / Sealed filter.
- **Review** lists due checks with their reason (misconception, fading, shaky) and memory strength, and starts
  the warm-up. The warm-up pill above the composer is unchanged.
- **Settings** holds Memory, Narration, Layout (Studio / Mobile / Device) and **Classic tools**.
- **Composer.** The Memory, End session and Trace pills moved to Settings and the arc. A status line ("Thinking…",
  "Your turn…") now shows above the composer when Y is not speaking.
- **Classic tools** (off by default) brings back the earlier surfaces unchanged:
  - the old Studio card (Teach me, samples, model choice, replay);
  - Practice;
  - the legacy chat;
  - on Mobile, the Teach me and clear buttons and the samples row.

  The **knowledge atlas stays on the board** as before.
- **Glass** is closer to Apple's liquid glass: a diagonal tint, a bright top-left rim and a soft inner glow. There
  is no refraction. Reduced transparency, or no blur support, still gives solid white.

## Design as built

- `components/places/RadialMenu.tsx`:
  - computes each item's position once with `arcPoint`;
  - hover and focus lift and labels are CSS only (`.y-arc-*` in `globals.css`), so there is no re-render on
    hover;
  - opening staggers the items by 18 ms each.
- `PlacesMenu.tsx` holds which place is open, and each place loads its code only when opened:
  - Mind uses `MindEntry` (renamed from `MindButton`: `MindView`, `useMindFresh`, `preloadMind`);
  - Canvases uses `CanvasDialog`;
  - Review and Settings are new sheets;
  - Trace uses `TraceView`;
  - End session is the existing `tutor.endSession`.
- `ToolDock.tsx` uses the new `WhiteboardHandle.setTool(tool, ink)` / `onToolChange(listener)`:
  - setting a tool calls `api.setActiveTool` and updates the pen style in `appState`;
  - `onChange` reports only real tool changes;
  - the highlighter is freedraw at 40 % opacity, yellow and wide.
- Excalidraw's toolbar, hint line and library button are hidden by CSS under `html[data-tool-dock]` while the dock is mounted. Excalidraw 0.18.1 offers no prop for this; the class names are pinned to that version.
- `lib/classic.ts` is a stored flag read with `useSyncExternalStore`, shared by the page and both shells.

## Packages

- `next` and `eslint-config-next` 16.3.3 → 16.4.4. The Next.js critical advisories are in `next/og` and
  `use cache`, neither of which Y uses, but this patches them before deployment.
- `npm audit fix` updated, within their ranges: `dompurify` 3.4.17, `sharp` 0.35.5, `source-map-js` 1.2.2.
- **Production audit: 0 critical and 0 high** (was 2 and 2).
  - 7 low remain in the KaTeX and Mermaid chain; they need breaking major upgrades and were left alone.
  - `@emnapi/runtime` and `@img/sharp-wasm32` are listed as extraneous. They are sharp's optional WASM
    pieces, which `npm prune` keeps; they are harmless.

## Checks

| Check | Result |
|---|---|
| Frontend `npm test` | 31 files, 166 passed (+6 in `places.test.tsx`; the card and composer tests updated for the moved controls) |
| `tsc --noEmit` (web) | exit 0 |
| Changed-file lint | exit 0 |
| `npm run build` (Next 16.4.4) | exit 0 |
| Backend `pytest -q tests scripts/test_teacher.py` | 384 passed (no API change) |

**Browser** (in-app, `next start` on 3015 → API on 8113, scratch DB copy):

- **Studio.**
  - The dock replaced Excalidraw's toolbar, and the board UI (menu, zoom, undo) stayed.
  - The arc opened with all six places; Canvases, Review, Settings, Mind and Trace each opened and closed.
  - Classic tools on showed Teach me, Practice and the chat orb; off hid them again.
  - The dock's Pen set Excalidraw's tool, and pressing `E` moved the dock to Eraser.
  - A stroke drawn after picking Blue was saved as `human` ink in `#1d4ed8` at full opacity.
- **Bug found and fixed:** the Y button covered the "Board saved" status, so it moved up 44 px.
- **Mobile (375 × 812).** The arc opened from the bottom bar with Teach me hidden and Learn (the atlas) kept.
  The arc was then widened (radius 150); this was not re-measured.
- **Not verified:** the hover lift by eye. The in-app browser's screenshots were cropped at this display's 1.5×
  scale, so the layout was checked by DOM geometry and one scaled capture. Reduced motion is unchanged from H8.

## Open

- The Mind page tweaks (since-last-session card, search, legend) are for a later pass.
- Trace does not yet record the voice transcription, Kokoro or image steps shown in the mockup.
- On Mobile the drawing tools are still Excalidraw's own.

## Follow-up fixes (same day, from the user's notes)

- **Ask with an empty box answers the board.**
  - If the learner has ink or text on the board, an empty Ask sends `BOARD_QUESTION` ("Answer the question I
    wrote on the board. If it shows my working, check it step by step.").
  - A blank board makes no request and shows "Write or draw your question on the board, or type it here."
  - Live: 0 requests on a blank board. A board with handwritten working got "Check your first step" and
    "Finish and get x", with 2 rings on the ink.
- **The writing keeps pace with the voice.** `SEGMENTS_AHEAD` is now 0 (write, then explain): a segment is drawn
  only after the previous one has been spoken. With narration off, nothing waits.
- **The board card shows only the question.** Its options live on the answer card beside it. The board copy
  remains the record, the anchor for the answer card, and the place for "You answered: …".
- **Mind.**
  - Neuron and region labels are placed on whole pixels and measured for centring; subpixel and percentage
    offsets made them shimmer while the map turned.
  - The region cards no longer blur the 3D canvas behind them on every frame.
  - Night (dark) is the default unless the learner chose Paper.
  - Not checked by eye in the browser.
- **Knowledge atlas.** A 56 px glass button with a node-tree icon and a ring that fills with the profile's
  certainty. Dragging and the panel work as before; the panel uses the reading glass. It stays clear of the zoom
  bar.
- **Places share one frame.** `PlaceSheet` (backdrop, reading glass, header, close button, Escape) is used by
  Canvases, Review and Settings; Trace uses the same header.
  - **Canvases:** board-like cards (the opening question in the board's hand on a dotted grid, with a state
    chip), a New canvas tile, search and a filter. A canvas opened with an empty Ask is titled "Question on the
    board".
  - **Review:** two columns, the due checks and the six latest sealed checks (from `GET /learning/profile/revisions`).
  - **Trace:** summary tiles (first move, voice start, models used) and a coloured, lettered stage per row.
- **Checks:** 167 frontend tests pass, plus tsc, lint, build, and a browser look at Canvases, Review and Trace.
