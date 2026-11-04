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
