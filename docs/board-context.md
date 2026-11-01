# Board capture and context harness

Branch: `feature/board-context`. This extends typed capture with saved Excalidraw scenes, app-observed edit attribution, automatic Practice regions, source-linked interpretations, and bounded context for assessment and Teach. Profile updates remain disabled in these new routes.

## Run and upgrade

The normal `main:app` and CPU-only `learning.app:app` both include the board endpoints. Use the existing local setup in [learning-capture.md](learning-capture.md). Configure `LEARNING_API_BASE` on the Next.js server. The existing speech/chat/legacy health controls retain their own backend configuration.

Local SQLite initializes automatically. For an existing Postgres deployment, run from `api` before updating the service:

```bat
.\.venv\Scripts\python.exe scripts/learning_preflight.py --init-db
```

Schema version 2 adds board, edit, checkpoint, asset, attempt, interpretation-cache, correction, and assessment-history tables. It does not alter or rewrite typed attempts. Repeating initialization is safe. SQLAlchemy binary storage is the initial asset implementation; metadata and source references are independent of the byte store. Postgres runtime validation remains outstanding without a configured server.

Set `MODEL_API_KEY` and optionally `META_MODEL` for handwriting perception. Baseten/TypeSafe settings remain as documented for conceptual rubric checks. Teach reuses the toolbar-selected existing teacher (Ollama, current Google GenAI, or OpenAI); this branch does not add a Meta teaching provider. The Google legacy SDK is intentionally unsupported for structured context: install the existing `cloud` extra. Updated Modal packaging includes the new image/stream dependencies, teacher, validator, parser, prompts, and schema; it has not been deployed.

## User flow

### Live smoke using your credits

Set `BASETEN_API_KEY` and `MODEL_API_KEY` in the root `.env`. Keep `DECISION_PROVIDER=baseten` and the default Elephant model. Do not put provider keys in `web/.env.local` or any `NEXT_PUBLIC_*` variable. Restart the API after changing keys.

From the repository root, start the CPU-only API in one CMD terminal:

```bat
cd api
.\.venv\Scripts\python.exe -m uvicorn learning.app:app --env-file ../.env --port 8101
```

In another terminal, from `api`:

```bat
REM Explain the test; makes no network requests:
.\.venv\Scripts\python.exe scripts/board_smoke.py
REM Explicit live run: uses the API's configured provider keys and can incur charges:
.\.venv\Scripts\python.exe scripts/board_smoke.py --live
```

The smoke creates a separate synthetic session, submits a native linear-algebra explanation to Baseten, then submits a generated digit-four ink crop to Meta and the deterministic stereo-depth verifier. It checks source receipts and retrieval, and reports readings, labels, and latency. It makes at most one decision call and two vision calls; no teaching call. A false reference match needs inspection even if contracts pass. This tests the running backend and provider wiring; it does not exercise the browser or certify real handwriting accuracy.

For the UI, start another terminal from the repo root:

```bat
set "LEARNING_API_BASE=http://127.0.0.1:8101"
npm run dev
```

The root npm scripts forward to `web`, so `npm run dev` works from either directory. For a fresh frontend dependency installation, run `npm run setup` from the root; it uses the existing frontend lockfile. API dependencies remain separate.

Open `http://localhost:3000/app`. Use Practice first: choose a task, click Answer on board, write inside its outline, wait for Board saved, then Check board work. Native text on a numeric task uses no paid provider. A conceptual native-text answer uses Baseten; freehand answers use Meta first. Inspect How Y read this, refresh to check restoration, then edit and resubmit to verify that readings update. The toolbar may show the legacy teacher offline with this capture-only API; the board Practice flow is independent of that status. The Teach button still needs an existing teacher provider; Meta/Baseten credits cover perception/assessment here, not a new Meta teaching loop.

1. The board restores before editing is enabled. The board and Practice share the persistent anonymous session. Opening a new tab shares that session; conflicting writes are rejected.
2. Changes save after 750 ms idle or five seconds of continuous editing. IndexedDB retains unacknowledged operations; reconnect and Retry save recover them. Export backup preserves local work when a newer remote revision prevents automatic recovery.
3. Choose a Practice task and **Answer on board**. Its prompt and 900 × 1,200 answer outline are separate, system-authored content. Write in that area, then **Check board work**. Disconnected work outside it produces incomplete coverage, not a silent partial grade.
4. **How Y read this** shows native text, interpreted handwriting, authorship, crop links, and a source hash. Clarifications append a human correction record; they do not overwrite the original reading or automatically promote its assessment.
5. **Teach** uses selection, active task region, then viewport precedence. It sends structured content plus focused visual crops, rather than a whole-board screenshot. Output reuses the validated primitive protocol and a reserved response area. Changing source elements stops stale generation; completed board work remains saved.

## Contracts and limits

- `GET /learning/sessions/{id}/board?revision=N`: current or historical scene and region metadata.
- `POST .../board/edits`: operation UUID, expected revision, actor-tagged element changes, and viewport. Lost acknowledgements retry with the same UUID/payload.
- `POST/GET .../board/assets[/{sha256}]`: bounded binary uploads and authenticated downloads. Assets deduplicate within the session.
- `POST .../board/regions`, `POST .../board/context`, `POST/GET .../board/attempts`: task regions, inference-free preview, and frozen source packets/history.
- `GET /learning/board-attempts/{id}`, `POST .../assess`, `POST .../corrections`: evidence receipts, provisional assessment, and append-only corrections.
- `POST .../board/teach`: authenticated SSE, with status, interpretation, context, primitive, completion, and error events. No legacy learner-update calls.

Board source schema v1 records session/revision, element revisions, content hash, and crop hashes. Interpreted text is not represented as an exact typed learner source. Human/model/system/unknown attribution is app-observed and client-reported, not cryptographic proof of independent work. Mixed/model content is excluded from independent evidence.

Caps: 5,000 live elements, 20,000 retained element IDs, 100 regions and 100 frozen context requests per session; 1 MiB edit batches; 2 MiB assets and 32 MiB assets per session. Oversized saves remain in the local outbox. Long-running sessions will eventually require retention/asset cleanup; none runs silently in this version.

Model detail is capped at 200 elements and 24 KiB of structured context. Other regions receive a small fixed-grid overview. Original scenes remain intact. At most two initial crops and two alternative detail crops are prepared; only the initial pair is read unless ambiguity requires the one allowed re-read. Each crop is at most 1,600 pixels per edge and two million pixels. Extremely spread-out ink is marked uncovered rather than compressed beyond the configured legibility bound. Crop pixels are generated by the application; hashes prove the captured bytes, not server-side pixel reconstruction from Excalidraw strokes.

## Efficiency and failure behavior

There is no inference during drawing. Native extraction and scene selection are deterministic. The browser scans IDs/versions, batches changed elements, and defers serialization to persistence. The API maintains a current scene and checkpoints every 50 edit batches. Scene persistence still has linear work in board size; this is not a constant-time design.

Successful visual readings cache by session, focused content and geometry, crops, model, and prompt version. Cache claims coordinate instances and reject concurrent duplicate paid reads. Mutable aliases expire after one hour; named revisions after one day. Only changed/relevant context invalidates readings. The reader transcribes/describes rather than solving; uncertainty is retained, with one bounded re-read. Consequential ambiguity blocks dependent grading/teaching; noncritical ambiguity may accompany an explanation without a routine confirmation dialog.

Vision, decision, and Teach calls each have shared caps of 120 global and 20 per owner/hour. Assessment uses a 60-second lease and 30-second total deadline. Teaching has a 25-second idle and 120-second total deadline. Missing keys do not spend provider budget or exhaust the attempt's retry allowance. Paid failures remain bounded to three assessment starts; source attempts and audit history remain saved. No database transaction spans inference.

Vision-derived numerical checks remain provisional, and conceptual decision-model observations remain shadow assessments. Neither model confidence nor an apparently correct transcription establishes mastery. Reviewed handwriting fidelity and rubric accuracy still need live evaluation.

## Verification

Automated checks cover revision conflicts, duplicate operations, lost acknowledgements, offline outbox recovery, historical reconstruction, checkpoints, asset ownership, mixed attribution, imports, deletions/undo, crop/reference validation, bounded/off-screen context, reading re-tries/cache invalidation, foreign source rejection, native assessment, authenticated teaching, and unchanged typed capture behavior. Frontend checks include streaming/binary proxy forwarding, TypeScript, lint, and a production build.

Local synthetic context selection measured about 1.8 ms for 500 elements / 7.0 KB and 15.4 ms for 5,000 elements / 20.6 KB in one run. These measure deterministic selection only, not inference, handwriting accuracy, rendering, or deployed capacity.

Automated verification: 118 backend tests and 32 frontend tests passed, with TypeScript, changed-file ESLint, and the production build. A synthetic browser-controller scan that changed one element took about 0.6 ms at 500 elements and 5.5 ms at 5,000; only that element entered the outgoing edit batch. These are local measurements, not browser or production latency guarantees.

The real browser smoke was attempted but the computer-use tool stopped because it could not establish the current Chrome URL. UI smoke verification remains outstanding. Automated provider/teaching tests use mocks. No live accuracy, latency, student-retention result, public deployment, or production capacity is claimed.
