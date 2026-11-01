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
5. Short quizzes/checks, reflection and a review queue grounded in learner work.
6. Between-session adaptation and a small evidence-backed knowledge map.
7. GEPA evaluator/baseline and, if gates pass, a capped offline optimization experiment.

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

Keep exact equations/LaTeX, diagrams, saved canvases, two-subject topic packs,
accessible tablet UI and independent-user isolation in the required feature set.
See the [feature coverage map](builds/FEATURE-COVERAGE.md) for every earlier idea,
including bounded 3D, Mermaid, images, tests, review and learning representation.

General 3D generation, arbitrary executable widgets, collaborative classrooms,
leaderboards, full exam administration, custom learner-model training and account/
billing systems are explicitly outside the hackathon scope. Bounded 3D or generated
illustrations are conditional additions, not dependencies of the core experience.

## Deadline rule

Complete selected hackathon feature coding by **November 3, 22:00 IST**. November 4
is reserved for demo recording/editing, submission and narrow fixes. The roadmap's
dated schedule replaces the earlier open-ended delivery wording. All required
hackathon slices are planned inside this window; optional work enters only after
the core gates pass. If execution slips, surface it immediately and reduce breadth
explicitly, rather than silently move required work beyond the deadline or skip tests.
