"""Reproducible Modal job for corpus generation and learner-adapter training.

Setup:
  modal secret create y-openai OPENAI_API_KEY=sk-...
  modal volume create y-learner-training
Run:
  modal run deploy/modal_train_learner.py --learners 4000 --turns 48
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
VOLUME_ROOT = "/training-output"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.5", "safetensors>=0.5", "numpy>=2.0",
        "openai>=2.0", "datasets>=3.0", "ollama>=0.4",
        "sentence-transformers>=3.4", "einops>=0.8",
    )
    .add_local_dir(str(ROOT / "api"), remote_path="/workspace/api")
    .add_local_dir(str(ROOT / "training"), remote_path="/workspace/training")
)

app = modal.App("y-learner-adapter-training", image=image)
volume = modal.Volume.from_name("y-learner-training", create_if_missing=True)


@app.function(
    gpu="A10G",
    cpu=4,
    memory=32768,
    timeout=60 * 60 * 12,
    volumes={VOLUME_ROOT: volume},
    secrets=[modal.Secret.from_name("y-openai")],
)
def train(learners: int, turns: int, labeler: str = "openai") -> dict:
    data = Path(VOLUME_ROOT) / "learner_trajectories.jsonl"
    checkpoint = Path(VOLUME_ROOT) / "learner-adapter-v1.safetensors"
    subprocess.run([
        "python", "/workspace/training/build_learner_corpus.py",
        "--output", str(data), "--learners", str(learners),
        "--turns", str(turns), "--labeler", labeler,
    ], check=True)
    subprocess.run([
        "python", "/workspace/training/train_learner_adapter.py",
        "--data", str(data), "--output", str(checkpoint),
        "--batch-size", "64", "--epochs", "30", "--patience", "4",
    ], check=True)
    volume.commit()
    return {
        "checkpoint": str(checkpoint),
        "config": str(checkpoint.with_suffix(".config.json")),
        "manifest": str(data.with_suffix(".manifest.json")),
    }


@app.local_entrypoint()
def main(learners: int = 4000, turns: int = 48, labeler: str = "openai") -> None:
    print(train.remote(learners, turns, labeler))
