"""Frozen embedding backends shared by learner training and evaluation."""
from __future__ import annotations

import math
import re
from functools import lru_cache


def hash_embedding(text: str, width: int = 768) -> list[float]:
    """Deterministic smoke-test embedding; never use for a release checkpoint."""
    import hashlib

    values = [0.0] * width
    for token in re.findall(r"[a-z0-9]+", text.lower()) or ["empty"]:
        digest = hashlib.blake2b(token.encode(), digest_size=16).digest()
        for offset in range(0, 16, 4):
            raw = int.from_bytes(digest[offset:offset + 4], "little")
            values[raw % width] += -1.0 if raw & 1 else 1.0
    norm = math.sqrt(sum(value * value for value in values)) or 1.0
    return [value / norm for value in values]


class FrozenEmbedder:
    def __init__(self, backend: str, device: str) -> None:
        self.backend = backend
        self.model = None
        if backend == "nomic":
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as exc:
                raise SystemExit(
                    "Release training requires `sentence-transformers`; "
                    "install it or use --embedder hash for a smoke test only."
                ) from exc
            self.model = SentenceTransformer(
                "nomic-ai/nomic-embed-text-v1.5",
                trust_remote_code=True,
                device=device,
            )
            self.model.eval()

    @lru_cache(maxsize=100_000)
    def __call__(self, text: str) -> tuple[float, ...]:
        if self.backend == "hash":
            return tuple(hash_embedding(text))
        vector = self.model.encode(  # type: ignore[union-attr]
            text,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        values = vector.tolist()
        if len(values) != 768:
            raise ValueError(f"nomic embedding width changed: expected 768, got {len(values)}")
        return tuple(float(value) for value in values)
