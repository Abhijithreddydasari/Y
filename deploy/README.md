# Deployment (H9): Vercel web, Modal API, Neon Postgres

Brief: [docs/builds/H9-deploy.md](../docs/builds/H9-deploy.md). The browser talks only to the Vercel site;
its server-side proxy calls the Modal API with a shared secret. Every key stays server-side; nothing is in
`NEXT_PUBLIC_*`. You run every sign-up, login and value-entering command yourself (Windows CMD, repo root).

The older event files (`modal_app.py`, `modal_demo.py`, `requirements-demo.txt`) are the earlier Gemma build,
not this deployment.

## 1. Tools and logins

```bat
python -m pip install "modal>=1.0"
python -m modal token new
npm i -g vercel
vercel login
```

## 2. Database (Neon)

Create a project in AWS us-east-1 at neon.tech. Copy the **direct** (not pooled) connection string. It
ends with `?sslmode=require`. Cut a branch named `pre-h9` as the rollback snapshot.

## 3. Modal secret

Generate the proxy secret. Keep it for step 6:

```bat
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Create `deploy\.env.modal`. The file is git-ignored; never commit it. Put these names in it, with your values:

```text
MODEL_API_KEY=
BASETEN_API_KEY=
OPENAI_API_KEY=
DEEPGRAM_API_KEY=
LEARNING_DATABASE_URL=
LEARNING_PROXY_SECRET=
EVIDENCE_LABEL_PROVIDER=openai
META_MODEL=muse-spark-1.3
DECISION_PROVIDER=
BASETEN_DECISION_MODEL=
```

Copy `DECISION_PROVIDER` and `BASETEN_DECISION_MODEL` from your local `.env` if you set them there; otherwise
leave them out. Then create the secret:

```bat
python -m modal secret create y-learning --from-dotenv deploy\.env.modal
```

To change a value later, add `--force` to the same command, then redeploy.

## 4. Create the tables, then deploy the API

```bat
python -m modal run deploy/modal_learning.py::init_db
python -m modal deploy deploy/modal_learning.py
```

The first build bakes the two Kokoro voices into the image, so it takes a few minutes. Modal prints the URL of
`api`; it looks like `https://<you>--y-learning-api.modal.run`. Check `<url>/health`. A request to any
`/learning/...` path without the secret must return 403.

## 5. Production limits

These are set in `modal_learning.py` (`LIMITS`):

| Limit | Value |
|---|---|
| Tutor turns per hour, global | 150 |
| Tutor turns per day, global | 1,500 |
| Tutor turns per learner per hour | 60 |
| Transcriptions per hour, global | 300 |
| Deepgram clauses per hour, global | 4,000 (past that, Kokoro speaks) |

Labels (60/300), images (10/60) and persona builds (20/300) keep their defaults. Edit `LIMITS` and redeploy to
change them.

One container stays warm (`Y_MIN_CONTAINERS=1`), about $2.80/day on 2 CPU / 3 GiB. After judging, deploy
with none kept warm:

```bat
set "Y_MIN_CONTAINERS=0"
python -m modal deploy deploy/modal_learning.py
```

## 6. Web (Vercel)

The project root directory is `web`. From `web`:

```bat
cd web
vercel link
vercel env add LEARNING_API_BASE production
vercel env add LEARNING_PROXY_SECRET production
vercel --prod
cd ..
```

Paste the Modal URL (no trailing path) and the same proxy secret when prompted. Do **not** set
`NEXT_PUBLIC_API_BASE`.

## 7. Rollback and kill switch

| What | Command |
|---|---|
| Web | `vercel rollback` (from `web`), or promote the previous deployment in the dashboard |
| API | `python -m modal app rollback y-learning`, or deploy an earlier commit |
| Stop all spend | `python -m modal app stop y-learning` (the site then shows "Learning service unavailable") |
| Database | Neon: restore from the `pre-h9` branch. The schema is additive, so old code runs on it. |

A daily Modal cron (`sweep_expired`, 03:30 UTC) deletes persona copies whose browser identity has expired.
