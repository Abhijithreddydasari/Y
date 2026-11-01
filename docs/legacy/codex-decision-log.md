# Codex decision log

This log makes the Build Week development process inspectable for judges.

## Decisions accelerated with Codex

### Separate learner model from teacher model

We rejected attaching a user adapter to the drawing LLM. The implemented design
uses a small, inspectable learner model and injects its deterministic summary
into any teacher provider. This keeps local/cloud teacher switching possible,
limits per-user storage, and creates a clean research ablation.

### Open-vocabulary evidence instead of hand-authored axes

The old panel inferred fixed traits from keywords. Codex replaced it with
concept embeddings, a variational state, arbitrary concept queries, and
confidence intervals. The UI explicitly says that no fixed axes are used.

### Two-speed evidence gate and rollback

`Solve` remains a help request and cannot teach the mastery decoder that the
user knows the generated answer. Every interaction may adapt representation;
only a submitted checkpoint with adequate grader confidence additionally
adapts mastery. Independent replay-loss regressions restore the relevant fast
weights. Tests exercise both paths and the untrained-checkpoint gate.

### Drawing and narration are independent

Codex separated visual playback from speech transport. Streamed primitives now
draw immediately with a short bounded reveal, while a single ordered narration
queue prefetches Kokoro audio. Voice changes invalidate stale prefetches without
cancelling drawing or losing the current-word resume point.

### Live constellation instead of percentage dials

The learner surface is now a draggable SVG constellation driven by the exact
revisioned SSE state. Evidence volume, uncertainty, qualitative status, and
semantic/co-occurrence relations have separate visual encodings. Detailed
percentages are intentionally secondary, behind node selection.

### Preserve the reliable drawing stack

Codex retained the parser, repair layer, Excalidraw, and KaTeX interfaces. Both
GPT-5.6 and Gemma stream the same primitive language, making the new work
demonstrable without coupling it to the later native-SVG research risk.

### License-conscious speech path

The browser's robotic voice was replaced behind a backend contract. Moonshine
Voice supplies a native MIT G2P implementation; two Kokoro voices are
allowlisted. The repo includes dependency locks, SPDX generation, third-party
notices, forbidden-asset scanning, and a release asset-lock step.

### Known-state synthetic evaluation

Rather than asking humans to annotate an invisible learner state, Codex built a
simulator from permissively licensed question banks. Hidden mastery is known by
construction, while GPT-5.6 supplies open-vocabulary item semantics and
misconceptions. This enables calibration and hidden-state correlation metrics.

## Key implementation checkpoints

- 9,433,857 global parameters verified from the shipped architecture.
- API and frontend contracts compile and are covered by mocked SSE integration.
- Offline corpus, CUDA mixed-precision training, and two-speed evaluation smoke
  paths execute; the smoke checkpoint is correctly rejected by promotion.
- The production build, lint, type-check, frontend tests, backend tests, and
  production dependency audit pass locally.
- A real research checkpoint must still pass the frozen-vs-Level-2 shipping gate
  after the Modal run. The code does not claim that a smoke checkpoint passes it.

## Submission reminder

Use the Codex task containing the majority of implementation work and run
`/feedback` before submitting. Record that session id in Devpost along with the
public repository/test access and the three-minute demo.
