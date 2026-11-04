# Live fixes handoff (2026-11-04)

Branch `fix/live-board-and-context`, cut from `main` at `f01574d`. Issues the user found on the live site, one commit each.
Decisions were agreed on the design canvas first. Not deployed until this file says so.

## Topic focus (API)

**Cause.** Four things pulled a turn off the learner's question:

- `compile_brief` only sorted by relevance, so all 24 items went out on any topic (offline: 24 items for "RoPE embeddings" on
  all three personas, at most 1 sharing a word).
- The prompt required the first turn to "visibly build on" them and "confront" misconceptions.
- The first brief on a canvas stood for every later question.
- Nothing said what "give me a graph" referred to.

**Fix.** A turn's brief holds only items about its topic; other concepts go in by name only, so their ids can be reused. Each
new topic compiles its own brief. Bare requests and short follow-ups get `continues_question`. New `topic_focus` prompt section,
rewritten `personalization`.

**Trade-off.** Matching is by words, so "RoPE" does not reach Priya's `positional-encoding`: no chip on loosely related topics.

**Live check (paid, 8 turns, `muse-spark-1.3`, no board, scratch DB):**

| Scenario | Old | New |
|---|---|---|
| Amara, RoPE graph, fresh canvas | Chip citing complex numbers | On RoPE, no chip |
| Amara, RoPE graph, after a potentials lesson | "Last time you worked on the harmonic well", chip citing the oscillator | On RoPE, no mention |
| Amara, "Can you give me a graph?" after RoPE | not run | Graph on RoPE |
| Priya, RoPE graph | not run | On RoPE, no chip |
| Priya, softmax (control) | not run | Chip and correction of her softmax belief |
| Tomás, photosynthesis | not run | On photosynthesis, no chip |

The user's exact turn (a graph of potentials) was not reproduced; the old code drifted in its text but drew a RoPE graph in
both samples. One new turn wrote a line echoing the prompt ("Say why this matters before the picture"), one sample, not fixed.

## One idea, one entry on the map (API)

**Cause.** The tutor picks concept ids and close picks belief names, and entries only merged on an exact id. Live: a new
base-rate belief sat beside the seeded one. A fixed topic list cannot work, because a judge can pick any subject.

**Fix.** The existing close call (no extra model call) now gets `known_beliefs` and returns `same_as` per named belief and
`same_concepts`. The server accepts only a real ledger id, or a session concept moving onto a known id, and refuses chains,
so a model error can miss a merge but not invent an entry. Teaching side: the concept-name list from Topic focus lets the
tutor reuse ids. Stored observations keep their original concept; the merge applies when the revision is built.

**Live check (paid, Spark Open on Tomás's profile, each case run twice):**

| Case | Result |
|---|---|
| Base-rate answer under new id `stats.base-rate-neglect` | Filed under the existing belief 2 of 2; concept merged 1 of 2 |
| `cv.cnn-receptive-field` against `cv.receptive-field` | Concept merged 2 of 2 |
| Variance scaling, a different idea | Stayed separate 2 of 2 |

A missed concept merge can still leave two neurons; a duplicate is reduced, not impossible.

## Question card stays out of the lesson (web)

**Cause.** When its board card left the screen, the answer card jumped to the bottom centre over whatever was there; near the
bottom edge it was pushed up over the lesson. There was no way to close it.

**Fix.** The card sits only below its board card, with its own scroll on a short screen. Off screen, without room, or closed
with the new X, it becomes a "Question waiting · Back to it" pill above the composer. The question stays open and a chosen
option is kept. A new question scrolls into view once, after the lesson's own closing scroll; later scrolling is respected.

**Browser (1280×800, local web, one paid turn):** under its board card on arrival; pill after scrolling away, a little and far;
Back to it returned the card under its anchor; X gave the pill. Not run: Mobile width, a short tablet viewport.

## Drawing tools remember, and stylus pinch zooms (web)

**Cause.** Picking Pen always forced width 2 and the dock's colour, overwriting anything chosen before. Pinch: once Excalidraw
sees a stylus it turns on pen mode, and in pen mode on the freedraw tool it fixes the zoom scale at 1, so two fingers only pan
(`scaleFactor` in Excalidraw 0.18.1).

**Fix.** One ink and a thickness per tool are kept across tools and reloads (`y_tool_memory_v1`), including choices in
Excalidraw's style panel. New thickness control on the dock. Pen mode is lifted only while two fingers are down
(`lib/pen-pinch.ts`), so palm rejection stays on otherwise.

**Browser (1280×800, local web):** red and thick survived Eraser and back, and a reload. With synthetic stylus and touch events
on the real board (pointer capture stubbed), a two-finger spread on the pen tool went 100% to 280%. A real tablet is not
tested; the user should confirm pinch and palm rejection there.

## Small board items

- **Device button removed (web).** It worked but changed nothing visible on a desktop. A first visit on a phone still picks Mobile.
- **Voice names (API).** The picker said Heart and Michael, "Kokoro", while Deepgram's Thalia and Apollo actually speak. With
  `DEEPGRAM_API_KEY` set it now names those. Ids are unchanged, so saved choices hold. Kokoro remains the fallback.
- **Thinking bulb (web).** A small yellow bulb shakes beside "Thinking…" in the status line; still under reduced motion.

## Logo: the Fold (web, board only)

The user picked the Fold draft in `#FFC400` from the design canvas. `YMark.tsx` draws it: yellow on the dark Y button, ink on a
yellow tile in the Mobile header and Classic toolbar. `app/app/icon.svg` is a dark tile for the `/app` browser tab. The landing
page keeps its own logo and `favicon.ico`, as asked (checked: its HTML links only `favicon.ico`).

## Mind: legend, search, what changed (web)

Agreed on the design canvas. Chips above the footer count neurons by state and filter the map; the rarer marks sit behind a `?`.
"Find a concept" narrows the map and flies there at 3 matches or fewer; Escape clears it before closing Mind. The footer's "N
changed" is now a button that lights those neurons. The evidence sheet opens with the state in plain words. Filters dim neurons
only: synapses, spikes and replay are unchanged, as asked. The header lost its hint line and revision number.

**Full-screen button removed.** On the live site the request neither resolved nor rejected in the in-app browser, leaving a dead
button with no feedback; that may be specific to that embedded view. Mind already fills the window, so the button only hid the
browser's own bars.

**Browser (1280×800, local web, sample map, 3D view):** chips with counts, filter dims and labels matching neurons, `?` key,
"2 changed" button, no full-screen button. Not run: Mobile width, Paper theme by eye, search fly-to by eye (tested with mocks).

## Persona isolation: no change needed

Each browser gets a private copy of a persona, and the template is never changed. **Checked on production** (no model call, two
new identities and their Priya copies left in Neon): both at revision 7 with 34 beliefs; A's new session returned 200 for A and
404 for B; canvas counts 8 and 7. Two judges on one browser share a copy; Settings has Reset.

## Checks on this branch

| Check | Result |
|---|---|
| Backend `pytest -q tests scripts/test_teacher.py` | 428 passed |
| Frontend `npm test` | 34 files, 188 passed |
| `tsc`, `npm run lint`, `npm run build` | exit 0 |
| One turn, answer and close through the running API, local SQLite (paid) | RoPE turn on topic with 0 brief items for Tomás; close reached revision 8, sealed 1 answer, named one new belief |

Not run: this branch on production; a real tablet (stylus pinch, palm rejection); Mobile width for the card pill and Mind chips.

## Deploy (when asked, repo root, CMD)

**Both.** API first: topic focus, merges and voice names are API changes.

```bat
python -m modal deploy deploy/modal_learning.py
deploy\vercel-prod.cmd
```

Then check `/health`, run one turn, and End one session. `feature/figure-breakdown` is not on this branch, so Break it down stays
off the live site.

## Found while testing locally (web)

- **Canvases card overflow.** The title had `line-clamp-3` and `block`; `block` overrode the clamp's display. Titles now clamp to
  three lines, with the full text as a tooltip. Browser: two cards measured 72 px, inside their header.
- **"Fractional indices invariant" console error.** Saved records come back sorted by id, and restore used that order, so a box's
  randomly named label could land far from its box, and z-order changed on reload. `stackingOrder` now restores the saved stack
  with each label right after its box. The validation is development-only; the wrong order affected production too.
  Browser, one paid turn: all 4 diagram labels sat ahead of their boxes in saved order. After a reload, plus a scene change past
  Excalidraw's 60 s validation throttle, no error was logged and the labels showed.
  `feature/figure-breakdown` has a smaller `stackingOrder` in this file; keep this version when merging.

## Mind colours mean what the legend says (web)

**Cause.** Reported as "all red in light mode", but it applied to both themes. Any concept past its review date was forced to
"shaky", and the seeded history is days old: 15 of 16 of Priya's neurons were shaky for that reason alone, none solid. Removing
that left all violet, because the score averaged each question type under its own prior, so three right answers of three kinds
still scored 0.67 and could not reach "solid" at 0.7.

**Fix.** Due for review no longer changes the colour; the evidence sheet and Review still show it. The state uses all of a
concept's answers under one prior. Priya now reads 5 solid, 8 learning, 2 shaky, 1 wrong belief (Tomás 4, 11, 1, 1; Amara 5, 8, 2,
2). Browser: Paper theme, 3D view, Priya: neuron colours match the chips. Replay blends the same mean.

## Voice and writing together (web, API timeout)

**Cause, voice.** Lines were cut at commas into separate clips, each synthesized alone, so the intonation restarted mid-sentence;
this is the likely cause of the robotic sound (inferred, audio was not heard). A clip late by 3.5 s also switched the rest of the
turn to the browser voice. Locally the API had no Deepgram key, so Kokoro spoke, and a clip came within about 0.2 s of that limit.

**Cause, sync.** A segment's writing finished before its voice began: the line appeared 1.9 s (production) and 3.5 s (Kokoro)
before the audio. The question could appear before the last explanation ended.

**Fix.** One clip per sentence (a sentence over 28 words splits at its central comma). Deepgram measured from here: about 1.5 s a
clause, 2.7 s a sentence, 6 s a whole line. The browser voice now only follows a real failure or a 20 s wait. A segment's heading
shows at once; the rest waits for the first clip (at most 6 s) and is then written across the voice's length, using the clip's
real rate. A question appears after the voice ends. With the voice off, everything is written at board speed. Removed the unused
`segmentsAhead` option. Server timeout for Deepgram went from 4 s to 10 s: a 21-word sentence took 4.9 s and would have fallen to
Kokoro mid-lesson.

**Limit.** The voice paraphrases the board, so words do not match one for one; each segment's writing starts and ends with its
voice. The first writing now waits for the first clip.

**Browser (1280×800, local web against an API on Kokoro, 5 paid turns):** frames showed the heading, then writing while the
audio played, and the card after the voice ended; widget turn drew and played; Stop cut the audio with nothing after it and Ask
returned; narration off drew two segments in 2.1 s with no audio. No browser voice in any turn. Deepgram itself was confirmed by
direct API calls (`x-speech-engine: deepgram`), not through a full lesson, and no one has listened to the result here.
