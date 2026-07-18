"""Measure the two local adapter latency gates on the active device."""
from __future__ import annotations

import asyncio
import json
import tempfile
import time
from pathlib import Path
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from learner import LearnerStore, normalise_evidence


def evidence(store: LearnerStore, index: int):
    item = normalise_evidence(
        {
            "concepts": [{"name": "fraction addition", "description": "adding unlike fractions"}],
            "outcome": {"correct": 0.8, "partial": 0.15, "incorrect": 0.05},
            "independence": 0.95,
            "evidence_strength": 0.95,
            "response_summary": f"Independent answer {index}",
        },
        user_id="benchmark", conversation_id="benchmark", source="checkpoint_answer",
    )
    width = store._model.cfg.embedding_dim
    item.event_embedding = [0.01 * ((index % 5) + 1)] * width
    item.embedding_source = "benchmark"
    for concept in item.concepts:
        concept.embedding = [0.03] * width
    return item


async def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        store = LearnerStore(root=Path(temp))
        profile = store.get("benchmark")
        seed = evidence(store, 0)
        profile.evidence.append(seed.to_dict())
        store.state_snapshot(profile)  # warm kernels
        started = time.perf_counter()
        store.state_snapshot(profile)
        inference_ms = (time.perf_counter() - started) * 1000
        update = evidence(store, 1)
        started = time.perf_counter()
        _, result = await store.record_evidence(update, allow_adaptation=True)
        update_ms = (time.perf_counter() - started) * 1000
        report = {
            "device": store.adapter_info["device"],
            "parameter_count": store.adapter_info["parameter_count"],
            "inference_ms": round(inference_ms, 2),
            "inference_target_ms": 50,
            "online_update_ms": round(update_ms, 2),
            "online_update_target_ms": 250,
            "adaptation": result,
            "passes": {"inference": inference_ms < 50, "online_update": update_ms < 250},
        }
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
