# Feature sessions and handoff

## Current handoff — 2026-11-01

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
- Next session: B00 baseline verification/review and scoped capture commit.
  Next feature afterward: [B01](builds/B01-natural-board-question.md).
- No PR/push. Agent checks should precede requests for user testing; ask for
  device-only feedback or credentials only when needed.

## Documentation ownership

- Root `AGENTS.md`: short discoverable index; `CLAUDE.md` refers to it.
- `docs/GOALS.md`: product purpose, priorities and exclusions.
- `docs/architecture.md`: intended system boundaries.
- `docs/design.md`: learner behavior and UI rules.
- `docs/builds/ROADMAP.md`: sequence and acceptance gates.
- `docs/builds/FEATURE-COVERAGE.md`: earlier ideas, required/conditional/excluded scope.
- `docs/ecc-usage.md`: four on-demand skills plus one optional security specialist.
- `docs/builds/Bxx-*.md`: one feature's detailed implementation contract.
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
   `git add .` on inherited work. No automatic push or PR.
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

Example instruction for the next feature after B00:

> Implement B01 from docs/builds/B01-natural-board-question.md. Read AGENTS.md and
> docs/workflow.md first. Stay within this slice, test it, update the handoff and
> make a scoped commit. Do not open a PR or push. Preserve unrelated work.

For the immediate next session request B00 from the roadmap. Until its baseline
commit exists, a fresh chat must account for the inherited working tree.
