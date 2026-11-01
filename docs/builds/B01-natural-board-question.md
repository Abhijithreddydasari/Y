# B01: natural question to native board explanation

Status: planned, not implemented by this documentation session.
Prerequisite: B00 reviewed, checks recorded and capture work committed.
Starting branch/commit: record at implementation start; never assume main is clean.

## Learner story

I type a question on an empty board or about visible typed equations/text. Y
explains beside my work without Practice, capture-region setup or extraction review.

## Scope

- Small question composer in both UI variants through the shared session controller.
- Real question in a versioned tutor request; authenticated saved source loading
  reuses the existing session, ownership and persistence.
- Native focus: explicit selection, otherwise viewport plus linked elements. Empty
  board has valid empty context. B02 adds recent-mark disambiguation.
- Meta teacher adapter with shared client, bounded request/output and sanitized
  errors. Verify current official streaming contract during implementation rather
  than assuming SDK compatibility from provider names.
- Stream validated existing primitives into safe response space; stamp model/source
  provenance and persist output. Reuse Stop and stale-source protection.
- Honest capability/configuration state; legacy offline indicators must not block
  a configured Meta path. Preserve legacy providers and typed Practice behavior.

Exclude voice, handwriting redesign, widgets, graphs, assessment and profile updates.
If relevant ink needs B02's reading, offer typed-question fallback instead of claiming
to understand unseen handwriting.

## Modules to extend

- `web/src/hooks/useTutorSession.ts`: question-to-board path, not legacy chat routing.
- Studio/Mobile shells and `Whiteboard.tsx`: composer/context handle/player.
- `web/src/lib/board-api.ts`, `board-types.ts`: request and stream contracts.
- `web/src/app/api/learning/[...path]/route.ts`: same-origin forwarding/limits.
- `api/learning/board_contracts.py`, `board_context.py`, `board_router.py`: question,
  bounded context, authenticated turn, cancel-safe stream.
- `api/teacher.py`: Meta adapter using current primitive parser/validator.
- Renderer/player/storage only where acceptance requires changes.

Do not migrate the database solely for a new class name. If durable turn receipts
need migration, define additive upgrade behavior and test an existing capture DB.

## Acceptance

1. Blank board: “Why does multiplying by an integrating factor help?” produces a
   relevant short explanation without region/Practice/setup steps.
2. Native-text linear-algebra work: question reaches Meta verbatim with the source;
   explanation appears beside it. Same service/renderer as the first example.
3. Refresh retains learner and model content with correct provenance.
4. Stop prevents queued additions; completed work remains.
5. Referenced-work edits stop stale output; unrelated edits need not stop it.
6. Missing credentials, timeout, malformed output and save conflict preserve work
   and question, with recoverable feedback and no duplicate automatic billing.
7. Cross-owner access denied; no legacy learner updates; `profile_updated=false`.

## Verification and artifacts

- Mocked stream tests: question propagation, empty context, bounds, invalid actions,
  interruption, source mismatch, ownership and retries.
- Frontend tests for composer-to-board, restore/errors/cancel, typed regressions,
  TypeScript, changed-file lint and production build.
- Real browser journeys for both subjects, with device and results recorded.
- Small live Meta checks when configured. Without keys, report mock-complete rather
  than live-verified. Assess correctness separately from latency.
- Measure save/context/provider-first-token/first-useful-render stages. Warm targets:
  p50 <3 s / p95 <6 s to useful output; report sample count and misses.
- Zero perception/decision calls for native-only requests; bounded unrelated context.
- Update brief/handoff with results and limitations; finish a scoped commit, no PR/push.
