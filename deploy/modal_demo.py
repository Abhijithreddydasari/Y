"""Event deployment: Gemma 4 + Y API on one warm Modal A10.

The product code remains provider-agnostic. This file owns all event-specific
model caching, GPU lifecycle, quotas, CORS, and learner persistence.

Prepare and deploy:

    python -m modal run deploy/modal_demo.py::seed_model
    $env:Y_DEMO_CORS_ORIGINS="https://your-project.vercel.app"
    $env:Y_DEMO_MIN_CONTAINERS="1"
    python -m modal deploy deploy/modal_demo.py

Stop after the event:

    python -m modal app stop y-event-demo
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import modal


REPO = Path(__file__).resolve().parent.parent
MODEL = "gemma4:e4b"
OLLAMA_HOST = "http://127.0.0.1:11434"
MODEL_MOUNT = "/root/.ollama"
LEARNER_MOUNT = "/data/learners"
DEMO_CORS_ORIGINS = os.environ.get("Y_DEMO_CORS_ORIGINS", "")
BUILD_REVISION = os.environ.get("Y_BUILD_REVISION", "modal-event")
MIN_CONTAINERS = int(os.environ.get("Y_DEMO_MIN_CONTAINERS", "0"))

app = modal.App("y-event-demo")
model_volume = modal.Volume.from_name("y-event-gemma4", create_if_missing=True)
learner_volume = modal.Volume.from_name("y-event-learners", create_if_missing=True)

ollama_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "zstd")
    .run_commands("curl -fsSL https://ollama.com/install.sh | sh")
)

api_image = (
    ollama_image
    .env({
        "CORS_ORIGINS": DEMO_CORS_ORIGINS,
        "BUILD_REVISION": BUILD_REVISION,
    })
    .pip_install(
        "fastapi>=0.115",
        "uvicorn[standard]>=0.32",
        "ollama>=0.4",
        "openai>=2.0",
        "pydantic>=2.9",
        "python-multipart>=0.0.18",
        "sse-starlette>=2.1",
        "pillow>=11",
        "httpx>=0.28.1",
        "numpy>=2.0",
        "torch>=2.5",
        "safetensors>=0.5",
        "moonshine-voice==0.0.69",
    )
    .add_local_dir(str(REPO / "api"), remote_path="/app/api")
    .add_local_dir(str(REPO / "schema"), remote_path="/app/schema")
)


def _start_ollama() -> subprocess.Popen:
    env = {**os.environ, "OLLAMA_HOST": "127.0.0.1:11434"}
    return subprocess.Popen(
        ["ollama", "serve"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )


def _wait_for_ollama(timeout: float = 180.0) -> None:
    import httpx

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            response = httpx.get(f"{OLLAMA_HOST}/api/tags", timeout=2)
            if response.is_success:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise RuntimeError("Ollama did not become ready")


@app.function(
    image=ollama_image.pip_install("httpx>=0.28.1"),
    volumes={MODEL_MOUNT: model_volume},
    cpu=4.0,
    memory=8192,
    timeout=60 * 30,
)
def seed_model() -> dict:
    """Download the exact event model once into a persistent volume."""
    process = _start_ollama()
    try:
        _wait_for_ollama()
        subprocess.run(["ollama", "pull", MODEL], check=True, timeout=60 * 25)
        model_volume.commit()
        return {"ok": True, "model": MODEL}
    finally:
        process.terminate()


@app.function(
    image=api_image,
    gpu="A10",
    volumes={MODEL_MOUNT: model_volume, LEARNER_MOUNT: learner_volume},
    cpu=4.0,
    memory=16384,
    timeout=60 * 20,
    min_containers=MIN_CONTAINERS,
    max_containers=1,
    scaledown_window=60 * 20,
)
# Keep speech/health requests responsive while a lesson SSE connection is open.
# The API governor still limits model generation to one active request.
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def fastapi_app():
    """Start local Ollama, warm Gemma, then expose the existing FastAPI app."""
    import httpx
    import sys

    os.environ.update({
        "OLLAMA_HOST": OLLAMA_HOST,
        "MODEL_NAME": MODEL,
        "LEARNER_STORE_DIR": LEARNER_MOUNT,
        "ADAPTER_DEVICE": "cpu",
        "SPEECH_PREFETCH": "1",
        "DEMO_RATE_LIMITS": "1",
        "DEMO_MAX_ACTIVE": "1",
        "DEMO_MAX_QUEUE": "12",
        "DEMO_LESSONS_PER_HOUR": "50",
        "DEMO_ASSESSMENTS_PER_HOUR": "50",
        "DEMO_CHATS_PER_HOUR": "100",
        "ALLOW_VERCEL_PREVIEWS": "0",
    })
    process = _start_ollama()
    _wait_for_ollama()
    tags = httpx.get(f"{OLLAMA_HOST}/api/tags", timeout=10).json().get("models", [])
    if not any(str(item.get("name", "")).startswith("gemma4:e4b") for item in tags):
        process.terminate()
        raise RuntimeError("gemma4:e4b is missing; run modal_demo.py::seed_model first")
    # Force weights into GPU memory before the endpoint is marked ready.
    warm = httpx.post(
        f"{OLLAMA_HOST}/api/chat",
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": "Reply only: ready"}],
            "stream": False,
            "options": {"num_predict": 1, "num_ctx": 4096},
            "keep_alive": "12h",
        },
        timeout=180,
    )
    warm.raise_for_status()
    sys.path.insert(0, "/app/api")
    from main import app as api  # noqa: PLC0415

    return api


@app.local_entrypoint()
def main(seed: bool = False) -> None:
    if seed:
        print(seed_model.remote())
    else:
        print("Run with --seed once, then deploy this file.")
