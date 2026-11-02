# Feature sessions and handoff

## Current handoff — 2026-11-01 (planning complete)

- Plan: [ROADMAP](builds/ROADMAP.md) H0–H10 with a dated day plan; decisions and live provider
  measurements in [harness decisions](decisions/2026-11-01-harness.md). License: MIT.
- H0 done ([handoff](handoffs/H0.md)): inherited tree committed, shared contracts in
  `tutor_moves.py`/`tutor_stream.py`/`learner_contracts.py` and their TypeScript mirrors.
  Next session: **H1** ([brief](builds/H1-meta-tutor-turn.md)).
- H1 done ([handoff](handoffs/H1.md)) on `feature/meta-tutor-turn`: typed question → Meta turn
  streamed onto the board → predict/check card waits → answer resumes; Stop and refresh restore.
  Live first move p50 1.89 s, p95 2.25 s over 20 turns. Next: H2–H5 per the day plan.
- H2 done ([handoff](handoffs/H2.md)) on `feature/voice-narration`. Push-to-talk → Muse Voice
  Transcribe goes through the same turn path; transcript p50 2.53 s for ~10 s questions.
  The board draws a turn in about 4 s (24–40 s before), then the voice follows each segment's
  `say`. Kokoro is served by `/learning/speech`. Stop and mute work mid-narration. The equation
  baseline fix is in. Next: H3–H5.
- H3 done ([handoff](handoffs/H3.md)) on `feature/board-artifacts`. Mermaid diagrams become editable
  board shapes. Plot, attention, matrix and stepper widgets live in Excalidraw embeddables (pen
  strokes pass through). Muse Image illustrations arrive later. The composer has a model and
  voice picker; Spark Open on Baseten measured fastest (p50 1.84 s, 5 turns). Live artifact
  validity: 26 of 26 turns, 1 move dropped. Next: H4 and H5.
- H4 done in code ([handoff](handoffs/H4.md)) on `feature/evidence-capture`. Each answered
  predict/check becomes one `Observation`, deduped on `(session_id, qid)`. Deterministic verifiers
  (option, number, symbolic) and a key audit run first; Elephant labels outcome, miss class and
  misconception in the background, and failures show only in `GET …/evidence`. **Live Elephant
  check blocked**: the Baseten key gets 403 on decision models. Next: H5.
- H5 done ([handoff](handoffs/H5.md)) on `feature/learner-model`. OpenAI Decisions
  (`gpt-6-luna`) labels evidence, reading learner ink crops: 14/14 live outcomes. End session
  seals one profile revision (Beta per concept × dimension, half-life, misconception ledger,
  Spark Open cited notes). The next session's brief drives a `because` chip, and Memory off is
  generic: gate met live, 2/2 pairs. Fix the card-mutation fractional-index bug before the demo.
  Next: H6–H9.
- Superseded plans (`HACKATHON_PLAN.md`, the B01 brief, the B-numbered feature coverage map)
  moved to `docs/legacy/`.
- The notes below describe the state before planning and remain accurate for the dirty tree.

## Slice status

Updated by whichever session finishes or integrates a slice. Details live in that slice's
`docs/handoffs/Hn.md`.

| Slice | Status | Commit | Handoff |
|---|---|---|---|
| H0 baseline + contracts | done | `66e491d` (inherited work `2039b59`, `5f23282`, `7bb4d5e`) | [H0](handoffs/H0.md) |
| H1 Meta tutor turn | done (branch `feature/meta-tutor-turn`) | `1a6e734`, `8338fad` | [H1](handoffs/H1.md) |
| H2 Voice in, narration out | done (branch `feature/voice-narration`) | `69085eb`, `d925a86`, `f70e40c` | [H2](handoffs/H2.md) |
| H3 Board artifacts + model/voice picker | done (branch `feature/board-artifacts`) | `785b9be`, `5133e1d`, `949b597`, `0b6672f`, `bbc2879` | [H3](handoffs/H3.md) |
| H4 Evidence capture | done, live label check blocked (branch `feature/evidence-capture`) | `6ebb8dc`, `7160a6b` | [H4](handoffs/H4.md) |
| H5 Learner model + visible adaptation | done (branch `feature/learner-model`) | `3edc208`, `ecc147a` | [H5](handoffs/H5.md) |
| H6–H10 | planned | — | — |

## Earlier handoff — 2026-11-01

- Branch: `feature/board-context`. This session organizes documentation only.
- Documentation baseline: `8b2ed3b`. Follow-up reconciles original features, fixes
  coding freeze at November 3 22:00 IST, archives old submission drafts, and adds
  selective ECC guidance. The user installs ECC; no installation/config changes.
- Existing board persistence/context/assessment/Teach work is in the dirty tree,
  excluded from this documentation commit. Inventory it before editing.
- See [board-context.md](board-context.md) for implemented foundations. Voice/chat
  still follows a legacy path; no Meta tutor, question-aware focus, interactive
  widget layer or session consolidation is implemented yet.
- Previously reported frontend checks: 34 tests, changed-file lint, production build.
  Previously reported full backend run: 118 tests; two later smoke tests passed
  separately. These are historical results, not a freshly verified baseline.
- Real browser capture smoke, live provider fidelity and Postgres runtime checks
  remain outstanding. This documentation session makes no live verification claim.
- Next session (superseded by the H-plan above): B00 baseline, then B01.
- No PR/push. Agent checks should precede requests for user testing; ask for
  device-only feedback or credentials only when needed.

## Documentation ownership

- Root `AGENTS.md`: short discoverable index; `CLAUDE.md` refers to it.
- `docs/GOALS.md`: product purpose, priorities and exclusions.
- `docs/architecture.md`: intended system boundaries.
- `docs/design.md`: learner behavior and UI rules.
- `docs/builds/ROADMAP.md`: slices, day plan, file ownership and acceptance gates.
- `docs/decisions/*.md`: settled decisions with the measurements behind them.
- `docs/ecc-usage.md`: four on-demand skills plus one optional security specialist.
- `docs/builds/Hn-*.md`: one slice's detailed implementation contract.
- `docs/handoffs/Hn.md`: what a slice session did, measured, left open and decided.
- This file: active handoff, verification and next action.
- Existing capture/setup docs: current API details and limitations.
- Legacy architecture and earlier hackathon calendars are history, not current scope.
- Do not read/search/index `starvector_test/`, `research/`, or `training/` without
  explicit user override. Do not load archived docs during ordinary feature work.
- Ignored `scratch-pad.md`: short reminders, never the sole record of a decision.

Do not duplicate architecture in `SPEC/ARCHITECTURE.md`; use the one authoritative
document and links. User instructions take precedence over repo documents.

## One session, one feature, one scoped commit

1. Read AGENTS, this handoff and the selected brief. Check branch/status and local
   instructions. Read adjacent implementation as needed, not the whole repository.
2. Establish learner-visible outcome/exclusions. Split an oversized brief before
   expanding implementation; retain a testable user journey for each slice.
   Check the dated schedule. Report a missed gate that day; do not silently move
   required work beyond November 3 or borrow November 4 for feature development.
3. Implement UI/request/service/persistence as needed. Reuse foundations, without
   unrelated cleanup or framework migration.
4. Test failures and the whole journey. Run applicable regressions, types, changed-file
   lint and build. Distinguish mocked, live and browser results; test behavior.
5. Review diff and secrets. Record exact results, latency samples, limitations and
   next step. Never mark a blocked check as passed.
6. Stage only the slice's files/hunks and inspect the staged diff. Commit with a
   descriptive message, e.g. `feat: explain native board questions`. Never use
   `git add .` on inherited work. No automatic push or PR. No AI tool or assistant
   names and no co-author/attribution trailers in branch names, commits or PRs.
7. Report outcome, commit, checks and material limitation. An incomplete checkpoint
   commit must be labeled incomplete and does not close the build.

The user authorizes this scoped commit workflow; do not repeatedly ask permission.
If tools or credentials block a check, complete independent work and record the
blocker instead of inventing success.

## Build-brief fields

- Status, starting commit/branch, learner story and acceptance scenarios.
- Scope/exclusions, modules to extend and necessary contracts/migrations.
- Failure/cancellation, ownership and recovery behavior.
- Performance budget, measurement method, tests and browser/provider checks.
- Completion evidence, commit and next handoff.

Write detailed briefs just before their build; distant builds need roadmap
boundaries, not speculative file-by-file implementation instructions.

## Start a fresh chat

Use one fresh chat per slice, not one per day: a slice fits comfortably in one context, and
the repository docs carry everything between chats. A day is several chats. Slices that the
roadmap marks as parallel can run at the same time only when their owned files do not
overlap; give each its own worktree/branch so they never edit the same checkout.

What a new chat needs, in order (it should read nothing else up front):
1. `AGENTS.md` (loaded automatically) — rules and repo map.
2. This file — current handoff and slice status.
3. `docs/builds/ROADMAP.md` — the slice's scope, gate and owned files.
4. The slice brief `docs/builds/Hn-*.md`. If none exists, the chat writes it first and
   asks the user to confirm before coding.
5. `docs/decisions/2026-11-01-harness.md` — measured model behavior and settled choices.
6. Handoffs of slices it depends on (`docs/handoffs/Hm.md`).

Every slice chat ends by writing `docs/handoffs/Hn.md` (done, commit, checks run with mocked
vs live labels, latency samples, open issues, decisions made), updating its row in
**Slice status**, and committing. Parallel chats only touch their own handoff file; the
end-of-day integration chat updates the table, merges branches and reruns all checks.

### Kickoff prompts

Slice chat:

> Implement H\<n\> from docs/builds/ROADMAP.md. Read docs/workflow.md (current handoff and
> slice status), the H\<n\> brief (write it first and show me if it doesn't exist) and
> docs/decisions/2026-11-01-harness.md before coding. Stay inside the slice's owned files.
> Test it (say which checks are mocked and which are live), write docs/handoffs/H\<n\>.md,
> update the slice status and make a scoped commit. No push or PR.

End-of-day integration chat:

> Integrate today's slices. Read docs/workflow.md and every docs/handoffs/H*.md from today.
> Merge the slice branches into the working branch, run the full frontend and backend
> checks and the main browser journey, fix integration breaks only, update Slice status and
> the current handoff, and write briefs for tomorrow's slices. Report what is behind the
> day plan in docs/builds/ROADMAP.md.

H0's baseline commits exist; a fresh chat starts from a clean tree.
