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
