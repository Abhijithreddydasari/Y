"""Production API for H9: learning.app (capture, tutor, personas, voice) on Modal CPU, Postgres on Neon.

Secrets live only in the Modal secret `y-learning` (see deploy/README.md for the names); none are in this file.
  modal run deploy/modal_learning.py::init_db     create or upgrade the tables (idempotent, additive)
  modal deploy deploy/modal_learning.py            serve; Vercel's server-only LEARNING_API_BASE points here
Narration is Deepgram Aura with Kokoro (baked into the image, warmed at start) as the fallback.
"""
import os
from pathlib import Path

import modal

REPO = Path(__file__).resolve().parents[1]
API = REPO / "api"
# Top-level modules learning.app reaches (teacher/parser/validator through the board router). A test checks this list.
MODULES = ("speech.py", "transcription.py", "teacher.py", "parser.py", "validator.py")
# Production budgets: tighter than local so judging cannot drain the model credits kept for H10.
LIMITS = {"Y_LIMIT_TUTOR_GLOBAL": "150", "Y_LIMIT_TUTOR_DAILY": "1500", "Y_LIMIT_TUTOR_OWNER": "60",
          "Y_LIMIT_TRANSCRIBE_GLOBAL": "300", "Y_LIMIT_SPEECH_GLOBAL": "4000",
          # Postgres pool per container (3 containers x 20 stays far under Neon's connection cap).
          "Y_LIMIT_DB_POOL": "12", "Y_LIMIT_DB_OVERFLOW": "8"}


def _bake_kokoro():
    """Download and audit the two Kokoro voices at image build, so no container downloads them."""
    import asyncio
    import sys
    sys.path.insert(0, "/app/api")
    from speech import get_speech_engine
    asyncio.run(get_speech_engine().prefetch())


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi>=0.115", "pydantic>=2.9", "httpx>=0.28.1", "anyio>=4", "numpy>=2.0",
                 "sqlalchemy>=2.0.36,<3", "psycopg[binary]>=3.2,<4", "pillow>=11",
                 "sse-starlette>=2.1", "openai>=2", "ollama>=0.4", "moonshine-voice==0.0.69")
    .env({"PYTHONPATH": "/app/api", "MOONSHINE_VOICE_CACHE": "/assets/tts", "SPEECH_CACHE_DIR": "/tmp/speech-cache",
          "SPEECH_PREFETCH": "1", "SPEECH_REQUIRE_LOCK": "0", "SPEECH_SLOTS": "2",
          "LEARNING_REQUIRE_POSTGRES": "1", "LEARNING_COOKIE_SECURE": "1", **LIMITS})
    # The Windows-made asset lock does not match the Linux download of one voice file, so no lock ships;
    # speech.py still rejects forbidden voice families.
    .add_local_file(str(API / "speech.py"), "/app/api/speech.py", copy=True)
    .run_function(_bake_kokoro)
    .add_local_dir(str(API / "learning"), "/app/api/learning", ignore=["__pycache__/**", "**/*.pyc"])
    .add_local_dir(str(API / "prompts"), "/app/api/prompts")
    .add_local_dir(str(REPO / "schema"), "/app/schema")
)
for module in MODULES[1:]:
    image = image.add_local_file(str(API / module), f"/app/api/{module}")

app = modal.App("y-learning", image=image)
secret = modal.Secret.from_name("y-learning")


# Pinned next to Neon (AWS us-east-1): unpinned containers landed far away and each query cost ~350 ms instead of ~3 ms.
@app.function(secrets=[secret], region="us-east", cpu=2.0, memory=3072, timeout=180, scaledown_window=600,
              min_containers=int(os.environ.get("Y_MIN_CONTAINERS", "1")), max_containers=3)
@modal.concurrent(max_inputs=16)
@modal.asgi_app()
def api():
    from learning.app import app as application
    return application


def _store():
    from learning.router import get_store
    return get_store()


@app.function(secrets=[secret], region="us-east", timeout=300)
def init_db():
    """Create every table (additive) and print table names only; no learner data or URLs."""
    from sqlalchemy import inspect

    from learning import image_jobs, observations, profile, study, tutor_storage
    from learning.personas import PersonaStore
    store = _store()
    store.initialize()
    tutor_storage.TutorStore(store)
    observations.ObservationStore(store)
    profile.ProfileStore(store)
    study.StudyStore(store)
    image_jobs.ImageJobs(store)
    PersonaStore(store)
    print(sorted(inspect(store.engine).get_table_names()))


@app.function(secrets=[secret], region="us-east", timeout=600, schedule=modal.Cron("30 3 * * *"))
def sweep_expired():
    """Daily: delete persona copies whose viewer identity has expired. Logs a count only."""
    from learning.personas import PersonaStore, sweep_expired as sweep
    print({"swept": sweep(PersonaStore(_store()))})
