# Thin-slice build roadmap

Current direction: 2026-11-01. All feature builds below are **planned**, not shipped.
Existing capture foundations are work in progress; see [workflow](../workflow.md).
Build IDs are stable scope identifiers, not day numbers. The dated schedule below
sets the hackathon coding deadline; estimates do not establish completion.

One build delivers one coherent user capability. Start one session with one build
brief and end with a scoped commit. If investigation reveals that the build cannot
be completed and verified in one session, split its acceptance scenario before
expanding scope. No architecture-only rewrite disguised as a feature build.

## B00 — Establish a trustworthy baseline

**Outcome:** current capture work has a reproducible starting point for new builds.

- Inventory the dirty tree and distinguish existing changes from new session work.
- Verify root startup, duplicate-key regression, saved-board refresh, offline
  recovery, and typed Practice compatibility. Do not redesign Practice here.
- Run relevant suites, TypeScript, changed-file lint, and production build.
- Run a real browser journey; record any blocked device/provider checks explicitly.
- Review and commit the existing capture implementation in its own scope; the
  documentation commit does not certify or include that implementation.
- Artifact: baseline commit, exact check results, known issues in the handoff.

**Gate:** no known source-loss or startup blocker. Live accuracy remains unverified
until credentials and reviewed cases are available. B01 follows this baseline.

## B01 — Ask a natural question and receive a board explanation

**Outcome:** type a question on an empty or native-text board; Meta answers beside it.

- One question composer, one authenticated board-turn path, and a Meta tutor adapter.
- Send the actual question with a saved revision and bounded native context.
- Use the current view/explicit selection as initial focus; no mandatory regions.
- Reuse validated primitives, renderer, model attribution, persistence, and Stop.
- Show unavailable/configuration errors without losing the question or board.
- No handwriting, voice, new graph widgets, evidence grading, or durable adaptation.
- Artifact: [B01 brief](B01-natural-board-question.md), route/stream tests, two-subject
  browser cases, request-to-first-visible-explanation measurements.

**Gate:** blank-board question and native-board follow-up both work; refresh retains
the explanation; Stop prevents later output; Practice is never needed.

## B02 — Ask about a marked handwritten step

**Outcome:** circle a step, type “why this step?”, and receive a relevant explanation.

- Fuse the question, recent marks, referenced labels, and spatial relationships.
- Distinguish a pointer/annotation from answer content; do not assume every circle
  encloses the latest text. Use indexed bounds/relationships, not pairwise scene scans.
- Highlight the inferred target unobtrusively; allow a tap to correct the target.
- Preserve exact native content and send bounded crops for visual content directly
  to the multimodal tutor when usable; structured reader only where needed.
- For unresolved consequential symbols, perform at most one focused re-read, then
  ask one specific clarification. Never silently solve a guessed problem.
- Cache normalized readings with source/spatial/model/prompt keys and shared claims.
- Artifact: human-reviewed handwriting/reference cases, native-versus-visual routing
  tests, coverage/cache tests, 500/5,000-element measurements.

**Gate:** off-screen dependencies, boundary strokes, ambiguous exponents, and two
possible “step 3” targets behave correctly. Unrelated content cannot grow input
without bound. Report critical-symbol errors and unresolved cases separately.

## B03 — Speak a question into the same board workflow

**Outcome:** hold/tap the microphone, ask, and get the same board response as B01/B02.

- Push-to-talk first, with permission, recording, sending, and cancellation states.
- Replaceable transcription provider; verify Meta transcription's current contract
  during this build. No mandatory local speech-model download for hosted users.
- Transcript and referenced board revision form one tutor turn, not a parallel chat.
- Bind recent board marks to that utterance; preserve timing/source references.
- Show editable transcript on failure or request; typing remains available.
- Bound recording duration/size; define audio retention and deletion before storing it.
  Raw audio is not automatically learner-assessment evidence.
- Artifact: speech adapter tests, denied-permission/offline cases, tablet-browser
  microphone check, end-of-recording-to-transcript latency/cost measurements.

**Gate:** empty-board and marked-step spoken questions work; denied permission and
mis-transcription are recoverable; one recording creates one turn.

## B04 — Explain aloud, pause, and accept interruption

**Outcome:** tutor draws and narrates a short explanation, then yields to the learner.

- Segment explanations with IDs shared by narration and visual actions.
- Reuse the existing player/queue behind a speech-output adapter; verify a suitable
  hosted or browser fallback. Speech transcription is not speech synthesis.
- Explicit explain/wait/continue states; learner questions interrupt immediately.
- Teach with prediction, hints, scaffolded steps, exploration and short retrieval
  checks. Respect requests for a full explanation; do not force a quiz every turn.
- Stop cancels generation, queued audio, and pending animations; completed work stays.
- Mute/captions/replay remain available. Audio failure leaves visual teaching usable.
- Initially interrupt via Stop/new question/mic activation; automatic acoustic
  barge-in, echo cancellation, and full-duplex conversation are deferred.
- Artifact: timing/cancellation tests, segment trace, real tablet audio/unlock checks.

**Gate:** narration does not explain a diagram before it is visible; no old-turn audio
or drawing leaks after interruption. The tutor waits after requesting learner input.

## B05 — Explore one reusable interactive plot

**Outcome:** change a slider on the board and watch a curve/transform change immediately.

- Build one anchored React widget layer that follows board pan/zoom and saves state.
- Tutor emits a validated plot specification: supported expressions, domains, labels,
  units, parameter ranges. No generated code execution or unrestricted evaluation.
- Compute updates locally; slider movements never trigger model requests.
- Reuse the widget for a differential-equation family and a linear-algebra example.
- Keep a small versioned topic-pack registry for concepts, tasks, rubrics, verifiers
  and widget specs; no subject-specific routes. Use one advanced reference and a
  smaller second-topic case. Preserve existing equations and static diagrams.
- Include widget specs/current values in bounded context and evidence references;
  supply a readable fallback for restore/export/unsupported rendering.
- Artifact: spec/version contract, numeric reference checks, pan/zoom/restore/touch
  tests, interaction frame-time measurements on a named device.

**Gate:** both examples use the same renderer; values and plots agree; widgets do
not block pen input or disappear after refresh. General 3D remains deferred.

## B06 — Animate a reusable diagram (optional before B07)

**Outcome:** follow information through a diagram, such as a residual block.

- A bounded node/edge/step specification drives a reusable diagram renderer.
- Play/pause/step controls share the narration timing contract from B04.
- Use the same tool for a second graph/algorithm; no hardcoded residual-network route.
- Preserve diagram source, model provenance, current step, and restoration behavior.
- Artifact: graph validation/layout checks, reviewed examples, playback/interrupt tests.

**Gate:** arrows and sequence match the intended computation; playback remains
readable and stoppable. This build can be skipped without delaying evidence work.

## B07 — Capture evidence unobtrusively during learning

**Outcome:** learner responses leave trustworthy, inspectable observations in the background.

- Append source-linked events for question, help, explanation, learner response,
  correction, widget prediction, and independent check. Reuse original board receipts.
- Trigger rubric assessment on meaningful learner answers/checkpoints, not each edit.
- Offer short board-based quizzes and an independent exit question; record hints,
  retries and assistance. Add a brief end-of-session reflection without interrupting
  ordinary questions or forcing users into the old Practice panel.
- Distinguish human, assisted, model, mixed, unknown, and unanswered material.
- Use applicable deterministic checks and selected Baseten/TypeSafe decision adapter.
- Assessment failure never blocks teaching. Shared budgets, idempotency, bounded
  background processing, and recovery apply; no in-process-only durable work queue.
- Store uncertainty/coverage, not a fabricated ability score; `profile_updated=false`.
- Artifact: event contract, reviewed rubric cases, attribution/duplicate-work tests,
  background job timing/cost traces and an optional evidence inspector.
- Session split: B07a delivers short checks with source receipts and reflection;
  B07b delivers background rubric observations. Each has its own tests and commit.

**Gate:** tutor-written answers cannot become independent mastery evidence;
watching a diagram produces exposure, not a successful assessment.

## B08 — Make the next session meaningfully different

**Outcome:** resume later and receive a justified adjustment based on prior evidence.

- Explicit, idempotent session close enqueues consolidation outside the live response.
- Version a learner-specific evidence overlay on concepts/propositions/prerequisites.
- Separate observed answers from inferred gaps and suggested next steps; retain sources.
- Begin with a transparent reducer/policy, not training per-user model weights.
- Retrieve a small relevant profile for a new turn; never inject the whole graph.
- Show a small concept/prerequisite map: encountered, assisted, supported and unknown
  are distinct. A node opens its evidence, uncertainty and suggested next practice.
- Add a compact review queue with due dates and mixed short questions based on the
  observed gaps. Preserve real elapsed time; same-day transfer is not delayed retention.
- Resume saved sessions/canvases from a minimal list; recover interrupted sessions
  without treating them as completed. Reuse existing storage rather than a new dashboard.
- Add an inspect/correct path and profile rollback; low evidence stays unknown.
- Only this build introduces supported profile writes. Legacy learner updates must
  remain isolated; `profile_updated` reflects the actual consolidation result.
- Artifact: reducer/migration design, duplicate-close/replay/isolation tests, two-session
  demonstration showing which evidence changed the second lesson and why.
- Session split: B08a delivers consolidation and changed next-session context;
  B08b delivers the small map/review queue and resumable-session entry point. Keep
  the graph view narrow, with the same underlying records across both subjects.

**Gate:** replaying finalization does not double-count; an unsupported misconception
does not become fact; the second session uses the resulting profile revision.

## B09 — Evaluate GEPA policy improvement offline

**Outcome:** required evaluator/trace contract and frozen baseline; a capped GEPA
experiment is conditional on the live product passing its gates before the freeze.

- Pick one bounded target, such as choosing a hint or clarification prompt.
- Build reviewed training/validation/held-out cases and a frozen baseline first.
- Run GEPA behind a reproducible offline runner with explicit cost/call limits.
- Evaluate teaching correctness, evidence fidelity, clarity, latency, and cost;
  prevent learner/session leakage between splits and preserve held-out cases.
- Promote only a versioned candidate that passes the declared gates; otherwise keep
  the baseline. No prompt mutation during a learner's live session.
- Artifact: dataset provenance, prompt/version hashes, optimizer configuration,
  held-out comparison, promotion decision and rollback procedure.

**Gate:** an improvement claim is supported by reviewed held-out results. Successful
optimizer execution alone is not learning improvement. Complete the evaluator and
baseline within the hackathon; attempt optimization only within the remaining
pre-freeze budget. An inconclusive or unrun optimization is reported honestly.

## Performance and release checks shared by all builds

These are initial **targets to measure**, not achieved performance or timeout values.

- Measure separately: saving, context selection, transcription, reader calls, tutor
  first token, first useful rendered content, first audible segment, total turn.
- Context selection: target p95 under 50 ms at 5,000 elements on a named test machine.
- Native question: target p50 under 3 s / p95 under 6 s to first useful visual output
  on a warm service. Visual turns: provisional p95 under 10 s, excluding user speech.
- Speech transcription: target p95 under 2 s after recording ends for short questions.
- Stop/mic activation: target local audio/animation stop within 150 ms, regardless
  of provider cancellation latency. Prevent stale results from being applied.
- Plot interaction: target p95 under 33 ms per update on the chosen tablet; no network.
- Record sample count, model/version, warm/cold state, network/device, and errors.
  Fewer than 20 trials: report individual/range results rather than a meaningful p95.
- Gate builds on measured behavior; missed targets require a specific fix or an
  explicit documented adjustment. UI spinners do not count as useful output.
- Existing caps remain: 200 detailed elements, 24 KiB structured context, at most
  two bounded crops per reading call, no inference while drawing.
- Every build includes applicable regression/security/source-preservation checks,
  tablet layout review, and honest mocked/live/browser validation status.

## Dated execution plan — all times IST

This replaces open-ended delivery. Feature coding ends **November 3 at 22:00**;
November 4 is recording/editing/submission with narrow fixes, not another build day.
Required scope is ambitious and completion is not guaranteed by this schedule.
Keep each session to one slice and commit; re-estimate after every gate.

- **November 1: shared-board foundation.** B00 baseline, B01 Meta question-to-board,
  B02 marked-step context. Start B09's small evaluation case/trace definition with
  the first tutor contract. Exit: saved native and handwritten questions work without
  Practice setup; ambiguous work is not guessed. Record the first live provider results.
- **November 2: the learning experience.** B03 voice input, B04 paced narration,
  B05 one interactive visualization, B07a short checks/reflection. Establish the
  first deployed thin slice on Vercel/Modal/Postgres and exercise real tablet input.
  Exit: ask -> see/hear -> manipulate -> answer -> save, across two reference topics.
- **November 3, first half: the learning loop.** B07b evidence, B08a consolidation,
  B08b small map/review/resume. Review B09 baseline cases and run the capped GEPA
  experiment only if the live loop is healthy. Exit: a second session uses traceable
  prior evidence and serves an appropriate review, with duplicate-close protection.
- **November 3, second half through 22:00: integration and freeze.** Complete the
  release slice, multi-owner/isolation/recovery checks, browser journeys, correctness
  review, latency/cost measurements and final UI polish. No optional feature may
  consume this reserved verification block. Record the release commit and open issues.
- **November 4:** record the working product, edit, check public links and submit.
  Use the user-agreed deadline from the original plan; recheck the event page when
  preparing submission rather than assuming its old schedule is still current.

B06 diagram animation, additional Mermaid conversion, bounded 3D and image
generation compete only for spare pre-freeze capacity. They do not delay B07/B08.
See [FEATURE-COVERAGE.md](FEATURE-COVERAGE.md) for restored scope and explicit cuts.

## Release strategy and schedule recovery

B01/B02 establish the core; B03/B04 establish the intended voice experience.
B05 is the first interactive-visual milestone. B06 is optional; B07/B08 establish
the actual session-learning loop. B09's evaluator/baseline is required; optimizer
execution/promotion depends on evidence quality and remaining pre-freeze time.

Treat deployment as a small separate release slice when a tested milestone is ready:
web on Vercel, CPU API on Modal, shared Postgres, hosted model APIs. Verify SSE,
cookies/ownership, migrations, restore, provider configuration and cold starts.
Exclude or secure legacy unowned endpoints before exposing a public service.
No AWS or own GPU fleet is required by this design. These are deployment choices,
not a claim that the existing services have already been deployed or load-tested.

Maintain a working integrated build at every commit. If a daily exit gate slips,
stop optional additions and report the concrete remaining work that day. Reduce
widget types/parameters, map breadth, animation polish and experiment size first.
Reuse the narrator, renderer, typed assessment and storage already present. Preserve
voice/board interaction, one visual exploration, trustworthy checks and a real
next-session change as the target product. Do not silently redefine these as later
work. If a required capability cannot pass by freeze, explicitly report the miss
and submit only working behavior rather than hide a failure or fabricate results.
