# Thin-slice build roadmap

Current direction: 2026-11-01. All feature builds below are **planned**, not shipped.
Existing capture foundations are work in progress; see [workflow](../workflow.md).
Build numbers describe dependency order, not days or duration promises.

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
- Distinguish human, assisted, model, mixed, unknown, and unanswered material.
- Use applicable deterministic checks and selected Baseten/TypeSafe decision adapter.
- Assessment failure never blocks teaching. Shared budgets, idempotency, bounded
  background processing, and recovery apply; no in-process-only durable work queue.
- Store uncertainty/coverage, not a fabricated ability score; `profile_updated=false`.
- Artifact: event contract, reviewed rubric cases, attribution/duplicate-work tests,
  background job timing/cost traces and an optional evidence inspector.

**Gate:** tutor-written answers cannot become independent mastery evidence;
watching a diagram produces exposure, not a successful assessment.

## B08 — Make the next session meaningfully different

**Outcome:** resume later and receive a justified adjustment based on prior evidence.

- Explicit, idempotent session close enqueues consolidation outside the live response.
- Version a learner-specific evidence overlay on concepts/propositions/prerequisites.
- Separate observed answers from inferred gaps and suggested next steps; retain sources.
- Begin with a transparent reducer/policy, not training per-user model weights.
- Retrieve a small relevant profile for a new turn; never inject the whole graph.
- Add an inspect/correct path and profile rollback; low evidence stays unknown.
- Only this build introduces supported profile writes. Legacy learner updates must
  remain isolated; `profile_updated` reflects the actual consolidation result.
- Artifact: reducer/migration design, duplicate-close/replay/isolation tests, two-session
  demonstration showing which evidence changed the second lesson and why.

**Gate:** replaying finalization does not double-count; an unsupported misconception
does not become fact; the second session uses the resulting profile revision.

## B09 — Evaluate GEPA policy improvement offline

**Outcome:** an evaluated policy candidate may improve one teaching decision safely.

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
optimizer execution alone is not learning improvement. This is post-core work.

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

## Release strategy

B01/B02 establish the core; B03/B04 establish the intended voice experience.
B05 is the first interactive-visual milestone. B06 is optional; B07/B08 establish
the actual session-learning loop. B09 depends on evidence quality, not the calendar.

Treat deployment as a small separate release slice when a tested milestone is ready:
web on Vercel, CPU API on Modal, shared Postgres, hosted model APIs. Verify SSE,
cookies/ownership, migrations, restore, provider configuration and cold starts.
Exclude or secure legacy unowned endpoints before exposing a public service.
No AWS or own GPU fleet is required by this design. These are deployment choices,
not a claim that the existing services have already been deployed or load-tested.

Freeze at the highest stable milestone before demo day. Do not rush missing voice,
widgets, or adaptation into an otherwise working demo; name omissions honestly.
