# H9 — Deployment brief

Status: approved 2026-11-03 with Deepgram narration and production caps added. Branch `feature/deploy` from `main` at `9de130f`.

## Learner (judge) story and gate

A judge opens the Vercel URL on a laptop or phone, types or speaks a question, and gets a board answer with a
Kokoro voice. They can pick a persona under Try as…, and End session saves into that mind. Every key stays
server-side, and per-owner and global budgets are active. Mocked tests are not presented as live.

## Topology

```text
browser ──same origin──▶ Vercel (web/, Next 16)
                          └─ /api/learning/[...path] proxy (Node, iad1)
                               │  Cookie: y_learning_identity  +  X-Y-Proxy-Secret
                               ▼
                         Modal CPU app "y-learning" (learning.app:app, Kokoro inside)
                               │
                               ▼
                         Neon Postgres (AWS us-east-1)
```

- **Web: Vercel**, root directory `web/`, the existing `web/vercel.json`. The function region is `iad1` (the
  default), next to Modal and Neon.
- **API: Modal CPU**, extending the existing `deploy/modal_learning.py`. It runs `learning.app:app`, the
  capture, tutor, persona and voice routers; the legacy `main.py` is not deployed. Settings: `cpu=2`,
  `memory=3072`, `min_containers=1` during judging, `scaledown_window=600`, `max_containers=3`,
  `@modal.concurrent(max_inputs=16)`, and `timeout=180`, which covers the 150 s SSE turn and the 90 s close.
  The image adds `speech.py`, `transcription.py` and `moonshine-voice==0.0.69`, and drops google-genai (teacher.py still imports ollama).
- **Postgres: Neon** (free tier, AWS us-east-1), on the **direct (non-pooled)** connection string.
  - Why Neon over Supabase:
    - it is plain Postgres and the app needs nothing more;
    - it is provisioned in under a minute;
    - its branches give a free snapshot for rollback;
    - Supabase's direct host is IPv6-only, so Modal would need its pooler, and its free projects pause after a
      week idle.
  - Why the direct string: the pool is small (3 + 2 per container × 3 containers ≤ 15 connections), and it
    avoids PgBouncer prepared-statement problems with psycopg 3.
  - Cost: Neon's idle suspend adds about 0.5 s to the first query after 5 idle minutes. `pool_pre_ping` already
    handles dropped connections.

## Narration: Deepgram first, Kokoro as backup

On the laptop's CPU, Kokoro's first audio trailed the board by 2–3 s (H2), so narration now goes through Deepgram first.

- **`/learning/speech` tries Deepgram Aura first.** It is a non-streaming WAV request with a 4 s timeout.
  - The picker's Kokoro ids map to Aura voices: Heart → `aura-2-thalia-en`, Michael → `aura-2-apollo-en`.
  - `X-Speech-Voice` still echoes the picker id, so the browser's voice check passes.
- **Then Kokoro, then the browser voice.** If Deepgram fails, times out or its budget is spent, Kokoro answers.
  Kokoro is baked into the image and warmed at start. If Kokoro also fails, the browser voice speaks. The board
  never waits on audio.
- `X-Speech-Engine` and `X-Speech-Ms` headers let the live check measure which engine answered and how fast.
- Because Kokoro is only the backup, the API runs on 2 CPUs and 3 GiB.

## Costs (estimates; the Modal and Neon rates come from third-party pages quoting their pricing)

| Piece | Per day |
|---|---|
| Modal: 1 warm container at 2 CPU and 3 GiB | about $2.80 (scale it to zero after judging) |
| Neon free and Vercel Hobby | $0 |
| Deepgram (about 4k characters per judge session) | about $0.12 per session, from the $200 free credit |
| Meta tokens: about 100k per judge session | capped below |

## Env vars and secrets

Nothing goes in `NEXT_PUBLIC_*`. Both hosts hold only what they need.

| Where | Name | Kind |
|---|---|---|
| Modal secret `y-learning` | `MODEL_API_KEY` (tutor, transcribe, images, board reader) | secret |
| | `BASETEN_API_KEY` (Spark Open close notes) | secret |
| | `OPENAI_API_KEY` (evidence labels) | secret |
| | `LEARNING_DATABASE_URL` (Neon direct, `sslmode=require`) | secret |
| | `LEARNING_PROXY_SECRET` (new, random 32 bytes) | secret |
| | `DEEPGRAM_API_KEY` (narration) | secret |
| | `EVIDENCE_LABEL_PROVIDER`, `META_MODEL`, `DECISION_PROVIDER`, `BASETEN_DECISION_MODEL` (same values as local `.env`) | config |
| Modal image env (in code) | `LEARNING_REQUIRE_POSTGRES=1`, `LEARNING_COOKIE_SECURE=1`, `SPEECH_PREFETCH=1`, `SPEECH_REQUIRE_LOCK=0` | config |
| Vercel, Production, **not** `NEXT_PUBLIC` | `LEARNING_API_BASE` (the Modal URL), `LEARNING_PROXY_SECRET` (same value) | secret |
| Vercel | `NEXT_PUBLIC_API_BASE` stays **unset** | — |

- **Modal:** the user writes the names above into a git-ignored `deploy\.env.modal` and runs
  `modal secret create y-learning --from-dotenv deploy\.env.modal`. Values are never printed or committed.
- **Vercel:** `vercel env add LEARNING_API_BASE production` and `vercel env add LEARNING_PROXY_SECRET production`
  prompt for each value.
- **Legacy calls:** `useTutorSession` still calls the legacy `fetchHealth`/`fetchLearner` at `NEXT_PUBLIC_API_BASE`.
  With it unset, those calls must fail silently. The build checks this, and skips the calls when the base is
  unset if they show an error.

## Cookie, CORS and the proxy hop

- **The browser only ever talks to the Vercel origin.** The API sets `y_learning_identity` with `HttpOnly`,
  `SameSite=Strict`, `Path=/` and `Secure` (`LEARNING_COOKIE_SECURE=1`), and no `Domain`. The proxy relays only
  that `Set-Cookie`, so the cookie belongs to the Vercel host. The proxy also adds `Secure` on https.
- **No CORS.** The learning app keeps no CORS middleware, so a browser calling Modal directly is refused. The
  proxy keeps its existing check that rejects cross-site and other-origin requests.
- **New: a shared proxy secret.** The Modal URL is public, so anyone could call the API without going through
  Vercel.
  - The proxy sends `X-Y-Proxy-Secret`, and middleware in `learning.app` returns 403 when the secret is
    configured and the header does not match, compared in constant time.
  - `/health` stays open.
  - The header never reaches the browser.

## Budgets and rate limits in production

These are already DB-backed through `learning_budgets` (hourly buckets), so they hold across containers:

| Job | Per owner / hour | Global / hour |
|---|---|---|
| Tutor turns and hints | 60 | 600 |
| Evidence labels | 60 | 300 |
| Board reads/teach | 20 | 120 |
| Assessments | 20 | 120 |
| Images | 10 | 60 |
| Persona copy builds and resets (per viewer) | 20 | 300; at most one copy per persona per viewer |

Gaps this slice closes, kept small:

- **Transcription** today is an in-memory window of 120 per owner per container. It moves to `_spend`: 120 per
  owner and 600 global.
- **Session close** needs no new budget. Its Spark Open notes call already charges the tutor budget.
- **Production caps protect the Meta credits kept for H10.** They are set through `Y_LIMIT_*` in the Modal image:
  150 tutor turns an hour globally, 1,500 a day globally, and 60 an hour per learner.
- **Deepgram** clauses get 600 per owner and 4,000 global an hour. Past either cap, Kokoro answers instead.
- **Identity minting** has no per-IP limit. The global caps bound total spend if someone rotates cookies.

The costs of persona copies are bounded by the build limits above, and a build makes no model call.

## Database creation and personas in prod

- **Creating the schema.** The new `modal run deploy/modal_learning.py::init_db` runs inside Modal with the
  secret. It calls `CaptureStore.initialize()` (additive `create_all`), then the tutor, observation, profile,
  study and persona stores' own table setup, and prints table names only. This avoids the Windows SQLAlchemy and
  psycopg problems locally. It is idempotent and is re-run after any schema change; every schema change so far
  has been additive.
- **Personas.** Try as… builds a private copy from the fixtures on demand, in 0.23–0.36 s on SQLite; this brief
  measures it on Neon. `scripts/seed_personas.py` is **not** needed in prod, and is not run, so there are no
  template owners.

## Expired persona-copy cleanup

This is cheap, so it is included. A daily Modal cron function, `sweep_expired`, wipes the copy owners whose
viewer identity has expired, using the existing `wipe`. Each run is capped at 200 copies and logs counts only. A
mocked test covers that an expired viewer's copies are removed and a live viewer's are kept.

## Rollback

- **Web:** `vercel rollback` (or promote the previous deployment in the dashboard). This is instant.
- **API:** `modal app rollback y-learning`, or `modal deploy` from the previous commit.
- **Kill switch:** `modal app stop y-learning` stops all spend. The proxy then answers 503 "Learning service
  unavailable".
- **DB:** before the first deploy, a Neon branch `pre-h9` is cut as a snapshot. Schema changes are additive, so
  rolling back code never needs a down-migration.

## Build steps

1. Code: the proxy secret header (web) and its middleware (api); the budget moves for transcription, close and
   speech; `modal_learning.py` (image, assets, `init_db`, `sweep_expired`, settings); `deploy/README.md`
   rewritten for this topology; `.gitignore` entry for `deploy/.env.modal`.
2. Tests (mocked):
   - the proxy sends the secret upstream and never to the browser;
   - the API returns 403 without the secret and 200 with it, and health stays open;
   - the new budgets return 429 past their limits;
   - the sweep;
   - a static check that every module `learning.app` imports is in the Modal image.
3. Full suites: backend pytest, `npm test`, tsc, lint, build.
4. **Ask the user** before each outward step: creating Neon, the Modal secret, `init_db`, `modal deploy`,
   `vercel env add`, `vercel --prod`. The user runs the logins and the commands that take values.
5. Live check on the deployed URL, from a fresh browser:
   - first move time;
   - first audio;
   - a persona switch;
   - End session (revision +1);
   - 10 speech clauses timed by engine (`X-Speech-Engine`, `X-Speech-Ms`);
   - a direct Modal call without the secret gets 403.

   Results are recorded in `docs/handoffs/H9.md` with sample counts.
6. Handoff, a slice-status row and scoped commits. No push.

## Exclusions

H10 (GEPA), a custom domain, accounts or cross-device sign-in, object storage for assets (they stay in
Postgres), Mobile polish, and deploying the legacy `main.py`.
