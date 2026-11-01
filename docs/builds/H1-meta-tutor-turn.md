# H1: Meta tutor turn with pause and resume

Status: planned. Prerequisite: H0 baseline commit and contracts.
Supersedes the earlier B01 brief (archived in `docs/legacy/`).

## Learner story

I ask a question on an empty board or about my work. Y writes and explains beside it one step at
a time, asks me to predict or check, and waits. When I answer, Y responds to my answer and
continues. I never set up regions or open Practice to ask for help.

## Scope

- Meta tutor adapter: `muse-spark-1.3`, `reasoning_effort=minimal`, streaming, strict
  `json_schema` for `{"moves": [...]}`. Shared async client, bounded output, sanitized errors.
- Incremental parser: emit each move when its array element closes; validate semantically
  (known kinds, enums, predict answer in options, mcq key in options, `because` refs in brief,
  widget spec shape, one check per turn, final `turn_end`). On failure: one in-turn repair
  request for that move, else drop it and log.
- Move → primitive mapping so the existing renderer and `lesson-player.ts` draw it. New card
  primitives for predict/check (options, free text, confidence slider) placed beside the work.
- Turn kinds: `question` and `answer` (check id, answer, confidence). A turn that ends with a
  predict/check enters a waiting state; the answer turn resumes it.
- Context packet in cache-friendly order: system prefix (role, pedagogy policy v1, move schema,
  widget catalog) → learner brief (empty until H5) → session memory (lesson map, last 3 turns
  verbatim, compact list of older segment goals and check outcomes, open check) → board focus
  (existing context builder, ≤ 2 crops) → this turn.
- Pedagogy policy v1 (our own wording): find the edge of what is known; one step, one fact;
  motivate each step; predict before reveals; check after a step with distractors that
  reflect specific wrong models; on a wrong answer teach again from another representation;
  honor "just tell me".
- Question composer in both shells; Stop; honest configuration errors.

Exclude: voice (H2), widgets/diagrams beyond rendering text/equations/shapes (H3), evidence
labeling (H4), profile writes (H5).

## Acceptance

1. Blank board: "Why do transformers divide attention scores by √d_k?" produces segments with a
   predict or check and then waits. Same code path for a linear-algebra question.
2. Answering the check (correct and incorrect) produces an appropriate feedback turn.
3. Native-text board work reaches the model verbatim; the explanation appears beside it.
4. Stop prevents further moves; completed moves stay; refresh restores board and waiting state.
5. Invalid moves never render; a malformed turn ends cleanly with a recoverable message.
6. Missing key/timeout keeps the question and board; no duplicate paid retries.
7. Latency on 20 live turns: first rendered move p50 ≤ 3.0 s, p95 ≤ 5 s; report all samples.

## Tests and evidence

- Unit: incremental parser (split chunks, escapes, nested strings), validator cases, mapping.
- Route/stream tests with a mocked provider: ordering, cancellation, repair, waiting state.
- Frontend: composer → board, check card answer → resume, Stop, restore.
- Live: 20 turns across two subjects with timing per stage; record mocked vs live clearly.
- Update the handoff and commit only this slice's files.
