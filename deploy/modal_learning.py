"""Optional CPU deployment for the first learning slice; does not deploy the teacher.

Create a Modal secret named y-learning containing LEARNING_DATABASE_URL and
BASETEN_API_KEY (or DECISION_PROVIDER=jev and TYPESAFE_API_KEY); initialize the
database with learning_preflight.py --init-db.
Then: modal deploy deploy/modal_learning.py
Point Vercel's server-only LEARNING_API_BASE at the returned base URL.
"""
from pathlib import Path

import modal

REPO = Path(__file__).resolve().parents[1]
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi>=0.115", "pydantic>=2.9", "httpx>=0.28.1",
                 "sqlalchemy>=2.0.36,<3", "psycopg[binary]>=3.2,<4", "pillow>=11",
                 "sse-starlette>=2.1", "openai>=2", "ollama>=0.4", "google-genai>=0.3")
    .env({"PYTHONPATH": "/app/api", "LEARNING_REQUIRE_POSTGRES": "1", "LEARNING_COOKIE_SECURE": "1"})
    .add_local_dir(str(REPO / "api" / "learning"), "/app/api/learning", ignore=["__pycache__/**"])
    .add_local_file(str(REPO / "api" / "teacher.py"), "/app/api/teacher.py")
    .add_local_file(str(REPO / "api" / "parser.py"), "/app/api/parser.py")
    .add_local_file(str(REPO / "api" / "validator.py"), "/app/api/validator.py")
    .add_local_dir(str(REPO / "api" / "prompts"), "/app/api/prompts")
    .add_local_dir(str(REPO / "schema"), "/app/schema")
)
app = modal.App("y-learning", image=image)


@app.function(secrets=[modal.Secret.from_name("y-learning")], min_containers=0, max_containers=3, timeout=180)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def api():
    from learning.app import app as application
    return application
