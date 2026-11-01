# Earlier ideas mapped to hackathon builds

Reconciled against `HACKATHON_PLAN.md` and the user's voice/pen workflow, 2026-11-01.
This map closes omissions; the [roadmap](ROADMAP.md) owns dates and acceptance gates.
Note: B-numbers below predate the H-slice roadmap of 2026-11-01. Where they differ, the
roadmap and [harness decisions](../decisions/2026-11-01-harness.md) win (for example, the
3D Constellation and Muse Image illustrations are now in scope).

## Required within the coding window

- **Natural tutor and context harness:** B01/B02. Meta explanation/perception, focused
  native text + images, source fidelity, dynamic references, bounded context.
- **Voice + typed questions + pen:** B01/B03/B04. One tutor turn path; input speech,
  board writing, synchronized narration, interruption, captions and text fallback.
  A separate persistent chat-history product is not needed for this milestone.
- **Pedagogy:** B04/B07. Guided hints/scaffolding, prediction, meaningful exploration,
  retrieval, feedback, independent transfer/exit check and optional reflection.
  Discovery and guided learning inform actions, not rigid app modes. Community
  learning/collaboration is outside this hackathon's implementation.
- **LaTeX/KaTeX, shapes, arrows and diagrams:** reuse and verify in B01/B04/B05.
  Preserve mathematical/diagram source specs; no new rendering engine.
- **Interactive graphs/plots:** B05. One supported plot family and reusable widget
  contract, local sliders, persistence, source-aware context and numeric verification.
- **Quizzes/tests:** B07a. Short questions and an unaided exit check in the board
  flow; modest mixed practice in B08b, not a full exam-management system.
- **Faithful capture with Baseten/Jev:** B07b, reusing implemented decision adapters.
  Start with selected Elephant; compare Mammoth/Joey only on reviewed cases if useful.
  Provider choice does not change source/provenance or promotion requirements.
- **Session-wise self-learning:** B08a. Sealed evidence, durable recoverable jobs,
  versioned profile/teaching notes and an observable change in the next session.
- **Knowledge representation and progress UI:** B08b. Concepts/prerequisites,
  propositions/reasoning provenance, personal evidence overlay, a small inspectable
  map and a due-review queue. No global intelligence score or ungrounded mastery.
- **Saved canvases, session history/resume:** B00 foundations and B08b compact entry UI.
- **Independent users:** shared ownership isolation and two-browser tests in release;
  simultaneous editing/classrooms and cross-device account recovery remain excluded.
- **Subject-independent packs:** B05/B07/B08. One advanced reference plus a smaller
  second subject uses the same routes, reducers, widgets and finalization logic.
- **GEPA groundwork:** B09 evaluator, baseline, trace/version contract and reviewed
  cases. Distinguish policy optimization from per-learner session consolidation.
- **Beautiful, focused UI:** every build; final tablet/phone layout and accessibility
  check at freeze. Restrained glass effects only where readability/performance hold.
- **Engineering/deployment:** tests, failure recovery, latency/cost traces, provider
  limits and staged Vercel/Modal/Postgres deployment throughout, not after the deadline.

## Conditional before freeze, never hidden dependencies

- **Animated diagram:** B06; reusable flow/graph playback for residual networks.
- **Mermaid:** one validated import/conversion tool if it saves time over existing
  diagrams. Sanitize and persist source; no general parser rewrite.
- **3D:** one bounded camera/ray or matrix scene if chosen as the flagship and
  prototyped successfully. Otherwise use plots/diagrams. General 3D generation is out.
- **Images:** existing asset insertion first; image generation only for illustrative
  scenes, never as the authoritative computation/plotting engine.
- **GEPA run/promotion:** capped experiment before November 3 freeze, only after
  live flow and evidence gates pass. Keeping the baseline is an acceptable result.

## Explicitly outside hackathon scope

Global leaderboards; full exams; social/community/classroom features; arbitrary
interactive code or general 3D generation; training learner models; self-hosted
decision models; broad image-generation workflows; billing/account platform.
These earlier ideas are retained here so they are not silently forgotten, but
they do not have hidden implementation commitments in this hackathon schedule.
