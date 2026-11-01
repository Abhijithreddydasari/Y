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

1. Smooth whiteboard interaction; nothing interrupts drawing.
2. Tutor accuracy and latency (Muse Spark, measured per stage).
3. Voice in and narration that follows what is drawn.
4. Self-learning that visibly changes the next session's teaching.
5. Learner representation: the **Constellation** map.
6. A calm, polished UI (glass chrome, opaque content, motion that never costs frames).
7. Interactive widgets and diagrams on the board; generated illustrations.
8. Quizzes woven into teaching: predict, check, exit ticket, review.

Pedagogy runs through all of these: find what the learner knows, one step at a time, predict
and check, reteach from a different representation. Saved sessions are called **Canvases**.
GEPA policy improvement is an offline extra after the above works.

Preserve saved work and provenance throughout. Accuracy and honest uncertainty
take precedence over an impressive but wrong demonstration.

## Reference journeys

- Demo arc (ML): session 1 on attention and softmax, with an interactive attention widget
  and a captured misconception; session 2 on multi-head attention or the KV cache, where Y
  skips what is solid, targets the misconception, and the Constellation shows the change.
- Linear algebra: ask about a transformation, explore a matrix/plot widget, answer a check;
  same code path as the ML arc (reuse check).
- Handwritten work: write steps, circle one, ask why; Y reads it, points at an error if any.

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

Model-written executable sims are deferred. Collaborative classrooms, leaderboards, full
exam administration, custom learner-model training and account/billing systems are outside
the hackathon scope. The 3D Constellation map and Muse Image illustrations are in scope;
neither may block the core teaching turn.

## Deadline rule

Complete selected hackathon feature coding by **November 3, 22:00 IST**. November 4
is reserved for demo recording/editing, submission and narrow fixes. The roadmap's
dated schedule replaces the earlier open-ended delivery wording. All required
hackathon slices are planned inside this window; optional work enters only after
the core gates pass. If execution slips, surface it immediately and reduce breadth
explicitly, rather than silently move required work beyond the deadline or skip tests.
