# Y: agent entry point

Read this index, then only the docs needed for the assigned build.

## Start here

- Product and priorities: [docs/GOALS.md](docs/GOALS.md).
- Build order and acceptance: [docs/builds/ROADMAP.md](docs/builds/ROADMAP.md).
- Current handoff and session/commit rules: [docs/workflow.md](docs/workflow.md).
- System boundaries: [docs/architecture.md](docs/architecture.md).
- Learner experience: [docs/design.md](docs/design.md).
- Next feature specification: [docs/builds/B01-natural-board-question.md](docs/builds/B01-natural-board-question.md).
- Existing capture contracts/setup: [docs/board-context.md](docs/board-context.md).
- Older hackathon plans and legacy architecture are historical, not current scope.

## Repo map

- `web/src/app`: Next.js routes, application entry, same-origin learning proxy.
- `web/src/components`: board, Studio/Mobile shells, panels.
- `web/src/hooks/useTutorSession.ts`: current shared UI/session orchestration.
- `web/src/lib`: board persistence, API contracts, rendering, playback, speech.
- `api/learning`: authenticated sessions, evidence, board storage/context/readers.
- `api/teacher.py`, `api/parser.py`, `api/validator.py`: teacher and primitive pipeline.
- `api/main.py`: full legacy service; `api/learning/app.py`: capture service.
- `api/tests`, `web/src/**/*.test.*`: backend and frontend tests.
- `deploy`: deployment definitions; `docs`: specifications and handoffs.

## Commands (Windows CMD, from repo root unless stated)

```bat
REM Install frontend dependencies using its existing lockfile:
npm run setup
REM API setup; requires uv and supported Python:
cd api
uv sync
cd ..
REM Run capture API in its own terminal:
api\.venv\Scripts\python.exe -m uvicorn learning.app:app --app-dir api --env-file .env --port 8101
REM Run web in another terminal:
set "LEARNING_API_BASE=http://127.0.0.1:8101"
npm run dev
REM Frontend checks:
npm test
npm run lint
web\node_modules\.bin\tsc.cmd --project web\tsconfig.json --noEmit
npm run build
REM Backend checks from api:
cd api
.venv\Scripts\python.exe -m pytest -q tests scripts/test_teacher.py
cd ..
```
Capture-only service does not provide legacy chat/speech endpoints. See setup docs
before testing those. Live paid-provider checks are separate from mocked tests.
For changed-file lint, run `npm run lint -- src/path/to/changed-file.ts` (path relative to web).

## Hard conventions

- One learner-visible feature per session, with tests, handoff, and a scoped commit.
- Inspect git status first. Never reset, stage, or commit unrelated existing work.
- No PR or push unless requested. Branch names must contain neither `codex` nor `data`.
- Voice/pen-first shared board is the product; typed input is the first implementation slice.
- Never require Practice, task-region creation, or capture review to ask for help.
- Keep APIs, storage, and tutor logic independent of demo subjects.
- Reuse Excalidraw and the renderer; no agent-framework migration in these builds.
- Preserve sources and human/model/system/unknown provenance; interpretation is separate.
- No inference during drawing; bound context, retries, concurrency, and paid calls.
- No secrets in logs, commits, browser bundles, or `NEXT_PUBLIC_*` variables.
- Keep ownership checks, source-version validation, cancellation, and recovery intact.
- Keep `profile_updated=false` until B08 explicitly adds tested session consolidation.
- No arbitrary model-generated JavaScript/HTML execution; use validated tool specs.
- Measure latency and fidelity separately; never present mocks as live validation.
- Follow `web/AGENTS.md` and local Next.js docs when changing frontend behavior.
- Keep scratch notes in ignored `scratch-pad.md`; durable decisions belong in docs.
- Give user-facing commands in CMD. Keep replies concise; report blockers honestly.
