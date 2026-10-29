# Session learning: evidence capture slice

Branch: `feature/session-learning-capture`.

This implements the October 29 capture milestone. A learner can open **Practice** on `/app`, select a task, submit an exact typed answer, inspect its evidence receipt, and recover the attempt after refresh or provider failure. It does **not** claim that persistent self-learning or improved learning outcomes have been demonstrated.

## What is implemented

- Topic/task/rubric/source/attempt/assessment contracts. Task content and numerical verifiers are server-owned; the client cannot choose its grade, rubric, owner, or source hash.
- Two reference packs, stereo vision/image features and linear transformations. The same routes and assessment service serve both. Numerical tasks check only numerical outcomes; they do not infer conceptual understanding.
- Immutable exact typed answers, SHA-256 source receipts, captured assistance metadata, versioned task snapshots, and append-only assessment runs.
- Jev Choice requests to the official TypeSafe endpoint, pinned model, response/distribution validation, response-size and time bounds, raw-result preservation, token/latency logging without answer text or keys.
- Explicit abstention for unavailable providers, malformed results, empty answers, source-integrity failures, and revealed solutions. Jev judgments stay in `pending_review` or `abstained`; there is no switch to silently promote them to validated mastery.
- Short database transactions, ownership isolation, request idempotency, 30-second assessment leases, recovery after expired leases, and rejection of stale-worker writes. No database transaction spans an inference request.
- Global and per-owner hourly assessment reservations in the database, shared across service instances. Current caps are 120 global / 20 per owner per hour, three assessment starts per attempt, and 100 captured attempts per session. These are conservative engineering limits, not measured capacity. Reservations include numerical checks and failed calls.
- An offline evaluation contract, frozen `capture-shadow-v1` baseline identifier, per-pack diagnostics, and a necessary promotion gate. Fourteen authored seed cases are explicitly unreviewed; they are engineering tests, not a calibrated Jev benchmark. GEPA optimization itself has not run.

## Run locally

The existing `main:app` serves `/learning/*`. For capture-only development without Torch, Ollama, or speech warmup:

```powershell
cd api
uv sync --extra postgres
.\.venv\Scripts\python.exe -m uvicorn learning.app:app --env-file ../.env --port 8101
```

In another terminal:

```powershell
cd web
$env:LEARNING_API_BASE = 'http://127.0.0.1:8101'
npm.cmd run dev
```

Open `/app`, then **Practice**. Numerical checks work without provider credentials. Other checks save the answer and honestly report assessment unavailability. The old whiteboard teacher has its own backend configuration and can show offline while the capture-only service is running.

Local storage defaults to ignored `api/data/learning.sqlite3`. The same repository accepts `LEARNING_DATABASE_URL=postgresql+psycopg://...` for deployment. SQLite is only the local/test fallback and must not be used across Modal containers or on a shared Volume.

## Credentials and preflight

Put `TYPESAFE_API_KEY` and `MODEL_API_KEY` in the root `.env`; never add them to frontend environment variables. Set `JEV_MODEL=jev-1.14.0` and `META_MODEL=muse-spark-1.3` unless a tested replacement is selected. Restart the API after changing its environment.

```powershell
cd api
# Configuration checks; no paid calls:
.\.venv\Scripts\python.exe scripts/learning_preflight.py
# Tiny synthetic provider calls after adding credentials:
.\.venv\Scripts\python.exe scripts/learning_preflight.py --live
# Initialize only the new learning tables in the configured database:
.\.venv\Scripts\python.exe scripts/learning_preflight.py --init-db
```

The Meta probe tests basic endpoint access. It is not a complete teacher integration, latency benchmark, or streaming-contract verification. Jev preflight validates the pinned response contract on a synthetic answer; it is not an accuracy evaluation. No live provider calls were made during implementation because keys were intentionally deferred.

## Deployment boundary

`deploy/modal_learning.py` provides a small CPU-only deployment for this slice, capped at three containers and eight concurrent inputs per container. It is not deployed by this change. Configure the `y-learning` Modal secret with the Postgres URL and TypeSafe key; initialize the schema first. This entrypoint requires Postgres and secure cookies. Set Vercel's server-only `LEARNING_API_BASE` to its URL.

The Next.js proxy keeps the guest credential in an HttpOnly, SameSite=Strict cookie, adds Secure on HTTPS, rejects cross-origin browser requests, limits body size, and forwards only the learning cookie to the configured backend. Each credential maps to a server-generated owner and expires after 30 days. This is an anonymous prototype identity, not account recovery. Clear-cookie or cross-device access does not recover that owner's data.

Postgres pools are bounded to five connections per API instance, with connection/pool timeouts. Budget for at most 15 connections at the current three-container cap, plus database administration and future workers. Load tests and production database validation remain required before claiming capacity. No Postgres server was configured for this implementation's test run; Docker Desktop's engine was not running.

The new schema is created explicitly for Postgres; subsequent schema changes need migrations. Add data-retention cleanup, shared anonymous-identity admission controls, and production monitoring before a public rollout. Existing legacy `/learner/{user_id}` endpoints still use the old learner store and are not protected by the new identity. This change does not make those endpoints ready for public multi-user access.

## Validation and known boundaries

Verified on October 29: **70 backend tests, 22 frontend tests**, frontend TypeScript checking, changed-file ESLint, and the Next.js production build passed. The final evaluation guard was then tightened and its three tests rerun successfully. Windows sandbox restrictions blocked asyncio socket creation, Vite cache renames, and Turbopack compilation on some runs; these checks passed when rerun with the required sandbox permissions.

- Backend tests cover exact round trips, idempotency across store instances, simultaneous duplicate captures/claims, ownership, budget rollback, expired-worker recovery, retry limits, raw-result retention, provider failures, strict response validation, numerical invariants, and both topic packs.
- UI tests cover save-before-assessment ordering, lost-response retries using the same attempt ID, reload restoration, unavailable providers, provisional feedback, and proxy origin/body/cookie boundaries.
- Browser checks exercised stereo and eigenvalue checks through the real local API, reloaded the page to restore saved work, and verified that an unavailable Jev assessment preserves the conceptual answer.
- Today's path captures typed answers. Board/voice source attribution, tracked tutor assistance, saved full canvas state, finalization jobs, profile revisions, next-session context, and Meta teaching integration remain later slices. Assistance in this slice is explicitly self-reported; a checkbox cannot prove independence.
- `profile_updated` is always false. The new capture route never calls the old learner adapter. The old teacher flow is unchanged and still has its legacy behavior; do not combine its mastery display with the new evidence as if a validated session-learning loop were complete.
- Losing a response preserves server-saved attempts. Unsaved drafts are not persisted across a page reload. Three failed assessment starts exhaust an attempt's automatic retry allowance; the answer and run history remain saved, and a fresh attempt can be submitted.

Official provider contracts used: [TypeSafe System One](https://docs.typesafe.ai/api/system-one), [Choice](https://docs.typesafe.ai/primitives/choice), [Meta overview](https://dev.meta.ai/docs/overview). Provider confidence is not calibrated learner mastery.
