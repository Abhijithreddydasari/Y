"""Modal deployment for the Y API in cloud-only mode.

We host the FastAPI app on Modal serverless, with the Gemma-4-31B "Cloud"
teacher path enabled via Google AI Studio. The "Edge" and "Edge fine-tuned"
options stay disabled here (Modal serves no Ollama daemon by default), and
the toolbar greys them out via the /health `ready` flag.

Setup once:
    pip install modal
    modal token new
    modal secret create y-google-ai \
        --from-literal GOOGLE_API_KEY=$YOUR_KEY \
        --from-literal CLOUD_MODEL=gemma-4-31b-it

Deploy:
    modal deploy deploy/modal_app.py

Modal will print a `https://<your-username>--y-api-fastapi-app.modal.run`
URL. Set that on Vercel as `NEXT_PUBLIC_API_BASE` and the frontend's "Cloud"
toolbar option will route there.

Because the JSON learner store doesn't survive container recycles, we mount
a small Modal volume at `/data/learners` so per-user mastery snapshots
persist across cold starts.
"""

from __future__ import annotations

from pathlib import Path

import modal

REPO = Path(__file__).resolve().parent.parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi>=0.115",
        "uvicorn[standard]>=0.32",
        "ollama>=0.4",  # optional; not actually used when cloud-only
        "pydantic>=2.9",
        "python-multipart>=0.0.18",
        "sse-starlette>=2.1",
        "pillow>=11",
        "httpx>=0.28.1",
        "google-genai>=0.3.0",
        "lxml>=5.3",
    )
    .add_local_dir(str(REPO / "api"), remote_path="/app/api")
    .add_local_dir(str(REPO / "schema"), remote_path="/schema")
)

app = modal.App("y-api", image=image)
learner_volume = modal.Volume.from_name("y-learner", create_if_missing=True)


@app.function(
    secrets=[modal.Secret.from_name("y-google-ai")],
    volumes={"/data/learners": learner_volume},
    cpu=1.0,
    memory=2048,
    timeout=600,
    min_containers=0,
    max_containers=4,
)
@modal.asgi_app()
def fastapi_app():
    """ASGI factory. Importing inside the function keeps cold start lean."""
    import os
    import sys

    sys.path.insert(0, "/app/api")
    # Force the learner store onto the persistent volume.
    os.environ.setdefault("LEARNER_STORE_DIR", "/data/learners")
    # Block Ollama defaults so the cloud teacher is the only enabled choice.
    os.environ.setdefault("OLLAMA_HOST", "http://disabled")

    from main import app as fastapi  # noqa: WPS433 - local import is intentional

    return fastapi
