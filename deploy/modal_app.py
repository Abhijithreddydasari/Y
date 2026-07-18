"""Modal deployment for Y's GPT-5.6-first public API.

The OpenAI teacher is the submission path. Google Gemma cloud compatibility
remains available; Ollama choices are disabled because Modal has no daemon.

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
        "openai>=2.0",
        "numpy>=2.0",
        "torch>=2.5",
        "safetensors>=0.5",
        "google-genai>=0.3.0",
        "lxml>=5.3",
    )
    .add_local_dir(str(REPO / "api"), remote_path="/app/api")
    .add_local_dir(str(REPO / "schema"), remote_path="/schema")
)

app = modal.App("y-api", image=image)
learner_volume = modal.Volume.from_name("y-learner", create_if_missing=True)
training_volume = modal.Volume.from_name("y-learner-training", create_if_missing=True)


@app.function(
    secrets=[
        modal.Secret.from_name("y-google-ai"),
        modal.Secret.from_name("y-openai"),
    ],
    volumes={
        "/data/learners": learner_volume,
        "/training-output": training_volume,
    },
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
    os.environ.setdefault(
        "LEARNER_ADAPTER_CHECKPOINT",
        "/training-output/learner-adapter-v1.safetensors",
    )
    # Block Ollama defaults so the cloud teacher is the only enabled choice.
    os.environ.setdefault("OLLAMA_HOST", "http://disabled")

    from main import app as fastapi  # noqa: WPS433 - local import is intentional

    return fastapi
