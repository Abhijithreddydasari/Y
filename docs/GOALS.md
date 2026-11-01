# Y: product goals

Status: current product direction, 2026-11-01. Implementation status lives in
[workflow.md](workflow.md); delivery order lives in [builds/ROADMAP.md](builds/ROADMAP.md).

## The experience

A learner opens a shared board, speaks or writes a question, and points to what
they do not understand. Y explains beside that work with appropriate visuals and
voice. The learner can interrupt, explore, answer, and return later to saved work.
The interface serves learning, not the machinery used to capture or assess it.

Tablet and stylus are the primary design target. Keyboard/mouse remain supported.
Questions may start on an empty board. Subjects are open; reference lessons do not
define backend schemas or tutor behavior.

## Priority order

1. Reliable question-to-explanation workflow on the shared board.
2. Accurate, bounded reference/context handling without manual region setup.
3. Voice input and paced, interruptible audiovisual teaching.
4. Reusable interactive visuals that clarify a concept.
5. Faithful background evidence of learner work and assistance.
6. Between-session adaptation grounded in that evidence.
7. Evaluated offline policy improvement with GEPA.

Preserve saved work and provenance throughout. Accuracy and honest uncertainty
take precedence over an impressive but wrong demonstration.

## Reference journeys

- Differential equations: write several steps, circle step 3, ask why it works;
  Y explains beside it, pauses, and accepts a follow-up without task setup.
- Linear algebra: ask about a transformation, explore a parameterized plot,
  and explain a prediction using the same product flow.
- Computer vision: explore residual-block information flow through an animated
  diagram. This is a later reference, not a prerequisite for the first build.

Each build must work for at least two relevant examples through the same code.
Passing examples demonstrates reuse, not universal subject accuracy.

## What success is not

- A Practice panel, extracted-text inspector, or knowledge graph alone is not the product.
- Listening, asking for help, and seeing a solution are not proof of mastery.
- Confidence scores are not calibrated measures of intelligence or fixed ability.
- No claim of improved retention until an appropriate evaluation supports it.
- Winning a prize is an ambition; the acceptance criteria are usable behavior.

Defer general 3D generation, arbitrary executable widgets, collaborative classrooms,
leaderboards, custom learner-model training, and account/billing systems. Do not
make them dependencies of the shared-board experience.

## Deadline rule

Retain November 3 as the last planned feature-building day and November 4 for
demo/editing and narrow fixes, per the user's agreed schedule. The roadmap extends
beyond that window. Ship the highest completed, verified slice; do not represent
future builds as working features or compress all builds into the hackathon.
