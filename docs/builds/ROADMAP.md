# Hackathon build plan

Status: active plan, 2026-11-01 (replaces the earlier B00–B09 sequence). Feature coding
ends **November 3, 22:00 IST**; November 4 is demo recording, editing and submission.
Design rationale and measured provider behavior: [harness decisions](../decisions/2026-11-01-harness.md).
Visual design overview: the "Y Harness Blueprint" artifact shared in the planning session.

Each slice delivers one learner-visible capability, with tests, a measured check and a scoped
commit. Slices marked with the same day can run in parallel sessions when their file ownership
does not overlap (table below). Priority tiers: **P0** must work end to end before **P1**
starts; **P2** only after P0 and P1 are stable.

## Slices

### H0 — Baseline and shared contracts (Nov 1, P0)

- Run backend/frontend suites, TypeScript and build on the inherited dirty tree; record results.
- Commit the inherited capture/board-context work in its own scoped commit(s) so later slices
  start from a clean tree. Do not redesign it.
- Add versioned contracts used by every later slice:
  - `TutorMove` (strict JSON schema; kinds: seg, write, equation, diagram, widget, image, say,
    predict, check, because, point, turn_end) with server-side semantic validation.
  - `Observation` (concept, dimension, outcome, misconception, miss class, assistance, confidence, sources).
  - `LearnerBrief` and `ProfileRevision`; `ConstellationGraph` (nodes, edges, revisions) with a mock fixture.
- Gate: suites pass (or failures recorded); contracts have schema tests; nothing learner-visible breaks.

### H1 — Meta tutor turn with pause and resume (Nov 1–2, P0, critical path)

Brief: [H1](H1-meta-tutor-turn.md). Muse Spark 1.3 (`minimal` effort) streams strict-JSON moves,
parsed per move into the existing primitives; pedagogy prompt v1; predict/check cards end the
turn and the learner's answer starts the next; bounded session memory; question composer.
- Gate: blank-board and native-text questions work; first move p50 ≤ 3.0 s, p95 ≤ 5 s on 20 live
  turns; a check waits for the learner; Stop and refresh behave; invalid moves are dropped or
  repaired once, never rendered.

### H2 — Voice in, narration out (Nov 2, P0)

- Push-to-talk → Muse Voice Transcribe (`/v1/asr/transcribe`, multipart `request` + `audio`,
  `audioEncoding: "WAV"`), proxied by the API; keyword hints from the board's terms.
- `say` moves bind to their segment's visuals; reuse `lesson-player.ts` lockstep with Kokoro and
  browser fallback; visuals render before their narration.
- Gate: spoken question → same turn path as typed; end-of-speech to transcript ≤ 3 s for a
  10 s question; Stop silences audio within 150 ms; denied mic leaves typing usable.

### H3 — Board artifacts (Nov 2, P0 for diagrams + 2 widgets, P1 for the rest)

- `diagram` moves: Mermaid → native Excalidraw elements through Excalidraw's converter.
- Widget host via Excalidraw embeddables (`renderEmbeddable`); fall back to an overlay positioned
  from scroll/zoom if the spike fails. Widgets: `plot` (expression + parameter sliders, safe
  evaluator, no code execution) and `attention` (tokens + temperature; widget computes scores).
  P1: `matrix`, `stepper`.
- `image` moves (P1): Muse Image generated asynchronously (~11 s measured), inserted as an image
  element with provenance when ready; illustrations only, never the source of math.
- Gate: sliders update locally with no network; widgets survive pan/zoom/refresh; pen input is
  not captured by widgets; a failed image leaves the lesson intact.

### H4 — Evidence capture (Nov 2, P0)

- Every answered predict/check (tap, typed, spoken, ink) becomes an `Observation` request.
- Baseten decision model labels outcome/misconception/miss class asynchronously; deterministic
  verifiers first; assistance and format weights recorded. Teaching never waits on labeling.
- Gate: duplicate submits do not double-count; tutor-authored content never counts as learner
  evidence; labeling failure is visible in the trace, not to the learner.

### H5 — Session-wise learner model and visible adaptation (Nov 2–3, P0)

- "End session" seals evidence; reducer updates Beta beliefs per concept × dimension (recall,
  understand, apply, analyze, transfer), recall half-life, misconception ledger.
- Muse Spark Open on Baseten (`meta-models/muse-spark-open-1026`, strict JSON) proposes teaching
  notes that must cite event IDs; uncited notes are dropped.
- Compile a ≤ 600-token brief for the next session's topic; `because` chips whose refs must
  exist in the brief; a Memory on/off toggle for the comparison.
- `profile_updated` reflects the real consolidation result.
- Gate: replaying session close does not double-count; session 2 opens with a visibly different
  first turn that cites session-1 evidence; Memory off reproduces the generic turn.

### H6 — Constellation (Nov 2 on mock data, Nov 3 wired, P1)

- 3D concept map (three + @react-three/fiber + drei + d3-force-3d): state colors, five-arc
  dimension ring, misconception flare, spring "wobble" drag, focus fly-to with evidence sheet,
  revision scrubber; lazy-loaded, render-on-demand, ≤ 150 nodes, static 2D for reduced motion.
- Gate: 60 fps on the demo laptop while idle-dragging; never mounted while drawing on the board.

### H7 — Study loop extras (Nov 3 AM, P1)

- Warm-up review cards at session start (due by half-life), exit ticket, hint ladder, voice
  teach-back labeled for the understand dimension; Canvas list to resume saved sessions.
- Gate: a session can run warm-up → teach → checks → exit ticket → close without dead ends.

### H8 — Pointing, trace drawer, UI polish (Nov 3, P1)

- `point` moves: Muse Spark grounding mapped crop → board, snapped to the learner's ink group via
  the reported line; ring drawn on the learner's work.
- Trace drawer: which model did what, latency per stage. Glass chrome on toolbar/composer/cards;
  opaque surfaces under ink/equations; motion respects reduced-motion; no frame drops on the board.

### H9 — Deployment (thin slice Nov 2 evening, final Nov 3, P0)

- Web on Vercel, API on Modal (CPU), Postgres, Kokoro hosting chosen by measured first-audio.
- Gate: a judge can open the URL, ask a question and get a voiced board answer; secrets stay
  server-side; per-owner budgets active.

### H10 — Policy improvement with GEPA (evaluator Nov 2–3, run Nov 3, P2)

- `api/policy_eval/`: scenarios (persona + hidden misconception + question), simulated student,
  judge, validator score; GEPA over `pedagogy_policy` / `check_writer` / `feedback_policy` with
  `max_metric_calls≈150`; promote only on held-out improvement ≥ 0.05.
- Gate: report baseline vs candidate honestly; no live prompt mutation.

## Day plan (IST)

| Day | Must finish | Parallel | Exit check |
|---|---|---|---|
| Nov 1 | H0; start H1 | — | Contracts committed; first Meta turn renders on the board |
| Nov 2 | H1, H2, H3 (P0 part), H4, H5 reducer + brief | H6 on mock; H9 thin deploy; H10 evaluator | Ask by voice → board + voice answer → check → answer recorded → close → brief changes next turn |
| Nov 3 AM | H5 complete, H6 wired, H7 | H3 P1 widgets + images | Two-session demo arc works locally |
| Nov 3 PM | H8, H9 final, pilot with 2 people, fixes | H10 run if H5 is stable | Freeze 22:00, release commit, known issues listed |
| Nov 4 | Demo recording, edit, submit | — | Submitted before 07:30 IST Nov 5 (9 PM ET Nov 4) |

If a day's exit check slips, cut in this order: H10 → H8 polish → H7 teach-back → H3 P1 widgets
and images → H6 scrubber. Never cut H1, H2, H4, H5 or H9.

## File ownership for parallel sessions

| Slice | Owns |
|---|---|
| H1 | `api/teacher.py` (Meta adapter), `api/learning/tutor_*.py`, `api/learning/board_router.py`, `web/src/lib/lesson-player.ts`, `web/src/lib/board-api.ts`, `web/src/hooks/useTutorSession.ts`, composer/check-card components |
| H2 | `api/transcription.py`, `web/src/lib/wav-recorder.ts`, mic UI, `web/src/lib/tts.ts` |
| H3 | `web/src/components/widgets/*`, `web/src/lib/renderer.ts` registry hook, Mermaid conversion, image insertion |
| H4/H5 | `api/learning/observations.py`, `profile*.py`, `decisions.py`, `storage.py` additions |
| H6 | `web/src/components/constellation/*` |
| H10 | `api/policy_eval/*` |

Contracts from H0 are the only shared surface; changing one needs a note in the handoff.

## Shared checks for every slice

- Measure, don't assume: record sample count, model, effort, warm/cold and network for latency.
- Mocked tests ≠ live validation; say which ran. Keep provider calls bounded and budgeted.
- No inference while drawing; Stop cancels pending output; learner ink is never moved or covered.
- Existing caps stay: 200 detailed elements, 24 KiB structured context, ≤ 2 crops per call.
