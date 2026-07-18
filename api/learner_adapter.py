"""Open-vocabulary probabilistic learner adapter.

The base network is deliberately separate from the lesson/drawing LLM.  It
turns a sequence of embedded learning events into a variational learner state
and answers arbitrary natural-language concept queries.  The final two
Transformer blocks and query decoder accept tiny per-user rank-4 LoRA deltas;
only those deltas are changed during test-time adaptation.

The default configuration has roughly 9.5M trainable base parameters and
about 35K fast parameters per learner.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping

import torch
from safetensors.torch import load_file
from torch import Tensor, nn
from torch.nn import functional as F


FastWeights = Mapping[str, Tensor]


@dataclass(frozen=True)
class AdapterConfig:
    embedding_dim: int = 768
    numeric_dim: int = 8
    model_dim: int = 512
    latent_dim: int = 256
    ff_dim: int = 1024
    heads: int = 8
    layers: int = 4
    max_events: int = 64
    lora_rank: int = 4
    lora_alpha: float = 4.0
    version: str = "y-learner-adapter-v1"

    def to_dict(self) -> dict:
        return asdict(self)


def _lora_delta(
    x: Tensor,
    fast: FastWeights | None,
    key: str,
    rank: int,
    alpha: float,
) -> Tensor | None:
    if not fast:
        return None
    a = fast.get(f"{key}.A")
    b = fast.get(f"{key}.B")
    if a is None or b is None:
        return None
    return F.linear(F.linear(x, a), b) * (alpha / rank)


class AdapterTransformerBlock(nn.Module):
    def __init__(self, cfg: AdapterConfig, index: int) -> None:
        super().__init__()
        self.cfg = cfg
        self.index = index
        self.attn = nn.MultiheadAttention(
            cfg.model_dim,
            cfg.heads,
            dropout=0.0,
            batch_first=True,
        )
        self.norm1 = nn.LayerNorm(cfg.model_dim)
        self.norm2 = nn.LayerNorm(cfg.model_dim)
        self.linear1 = nn.Linear(cfg.model_dim, cfg.ff_dim)
        self.linear2 = nn.Linear(cfg.ff_dim, cfg.model_dim)

    @property
    def fast_enabled(self) -> bool:
        return self.index >= self.cfg.layers - 2

    def forward(
        self,
        x: Tensor,
        causal_mask: Tensor,
        padding_mask: Tensor | None,
        fast: FastWeights | None,
    ) -> Tensor:
        attn, _ = self.attn(
            x,
            x,
            x,
            attn_mask=causal_mask,
            key_padding_mask=padding_mask,
            need_weights=False,
        )
        if self.fast_enabled:
            delta = _lora_delta(
                x,
                fast,
                f"blocks.{self.index}.attn",
                self.cfg.lora_rank,
                self.cfg.lora_alpha,
            )
            if delta is not None:
                attn = attn + delta
        x = self.norm1(x + attn)

        hidden = self.linear1(x)
        if self.fast_enabled:
            delta = _lora_delta(
                x,
                fast,
                f"blocks.{self.index}.ff1",
                self.cfg.lora_rank,
                self.cfg.lora_alpha,
            )
            if delta is not None:
                hidden = hidden + delta
        hidden = F.gelu(hidden)
        output = self.linear2(hidden)
        if self.fast_enabled:
            delta = _lora_delta(
                hidden,
                fast,
                f"blocks.{self.index}.ff2",
                self.cfg.lora_rank,
                self.cfg.lora_alpha,
            )
            if delta is not None:
                output = output + delta
        return self.norm2(x + output)


class LearnerAdapterModel(nn.Module):
    """Causal event encoder plus variational open-vocabulary decoder."""

    def __init__(self, cfg: AdapterConfig | None = None) -> None:
        super().__init__()
        self.cfg = cfg or AdapterConfig()
        torch.manual_seed(17)
        self.event_projection = nn.Linear(
            self.cfg.embedding_dim + self.cfg.numeric_dim,
            self.cfg.model_dim,
        )
        self.position = nn.Parameter(
            torch.zeros(self.cfg.max_events, self.cfg.model_dim)
        )
        nn.init.normal_(self.position, std=0.01)
        self.blocks = nn.ModuleList(
            AdapterTransformerBlock(self.cfg, i) for i in range(self.cfg.layers)
        )
        self.final_norm = nn.LayerNorm(self.cfg.model_dim)
        self.posterior_mu = nn.Linear(self.cfg.model_dim, self.cfg.latent_dim)
        self.posterior_logvar = nn.Linear(self.cfg.model_dim, self.cfg.latent_dim)
        self.concept_projection = nn.Linear(
            self.cfg.embedding_dim,
            self.cfg.latent_dim,
        )
        self.decoder1 = nn.Linear(self.cfg.latent_dim * 2, self.cfg.latent_dim)
        self.decoder2 = nn.Linear(self.cfg.latent_dim, 1)
        nn.init.normal_(self.decoder2.weight, std=0.02)
        nn.init.zeros_(self.decoder2.bias)

    @property
    def parameter_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def fast_shapes(self) -> dict[str, tuple[int, int]]:
        """Return ``key -> (input_dim, output_dim)`` for per-user LoRA."""
        shapes: dict[str, tuple[int, int]] = {}
        for i in range(self.cfg.layers - 2, self.cfg.layers):
            shapes[f"blocks.{i}.attn"] = (self.cfg.model_dim, self.cfg.model_dim)
            shapes[f"blocks.{i}.ff1"] = (self.cfg.model_dim, self.cfg.ff_dim)
            shapes[f"blocks.{i}.ff2"] = (self.cfg.ff_dim, self.cfg.model_dim)
        shapes["decoder1"] = (self.cfg.latent_dim * 2, self.cfg.latent_dim)
        return shapes

    def init_fast_weights(self, *, device: torch.device | str = "cpu") -> dict[str, Tensor]:
        """Create deterministic rank-4 adapters (random A, zero B).

        Random-A/zero-B is the standard non-degenerate LoRA initialization:
        predictions begin identical to the base model while B receives a
        gradient on the first online step.
        """
        result: dict[str, Tensor] = {}
        generator = torch.Generator(device="cpu")
        generator.manual_seed(29)
        rank = self.cfg.lora_rank
        for key, (input_dim, output_dim) in self.fast_shapes().items():
            a = torch.randn(rank, input_dim, generator=generator) * 0.01
            b = torch.zeros(output_dim, rank)
            result[f"{key}.A"] = a.to(device).requires_grad_(True)
            result[f"{key}.B"] = b.to(device).requires_grad_(True)
        return result

    def encode(
        self,
        event_embeddings: Tensor,
        numeric_features: Tensor,
        *,
        lengths: Tensor | None = None,
        fast: FastWeights | None = None,
    ) -> tuple[Tensor, Tensor]:
        if event_embeddings.ndim != 3:
            raise ValueError("event_embeddings must have shape [batch, time, 768]")
        batch, time, width = event_embeddings.shape
        if width != self.cfg.embedding_dim:
            raise ValueError(f"expected embedding dim {self.cfg.embedding_dim}, got {width}")
        if time < 1 or time > self.cfg.max_events:
            raise ValueError(f"time dimension must be 1..{self.cfg.max_events}")
        if numeric_features.shape != (batch, time, self.cfg.numeric_dim):
            raise ValueError(
                f"numeric_features must have shape {(batch, time, self.cfg.numeric_dim)}"
            )
        if lengths is None:
            lengths = torch.full(
                (batch,), time, dtype=torch.long, device=event_embeddings.device
            )
        lengths = lengths.clamp(min=1, max=time)

        x = torch.cat([event_embeddings, numeric_features], dim=-1)
        x = self.event_projection(x) + self.position[:time].unsqueeze(0)
        causal_mask = torch.triu(
            torch.ones(time, time, dtype=torch.bool, device=x.device),
            diagonal=1,
        )
        positions = torch.arange(time, device=x.device).unsqueeze(0)
        padding_mask = positions >= lengths.unsqueeze(1)
        for block in self.blocks:
            x = block(x, causal_mask, padding_mask, fast)
        x = self.final_norm(x)
        final = x[torch.arange(batch, device=x.device), lengths - 1]
        mu = self.posterior_mu(final)
        logvar = self.posterior_logvar(final).clamp(-6.0, 2.0)
        return mu, logvar

    def query(
        self,
        mu: Tensor,
        logvar: Tensor,
        concept_embeddings: Tensor,
        *,
        fast: FastWeights | None = None,
        samples: int = 16,
        deterministic: bool = False,
    ) -> tuple[Tensor, Tensor]:
        """Return mastery mean and standard deviation for each concept.

        ``concept_embeddings`` may be ``[batch, 768]`` or
        ``[batch, concepts, 768]``.  The returned tensors are always
        ``[batch, concepts]``.
        """
        if concept_embeddings.ndim == 2:
            concept_embeddings = concept_embeddings.unsqueeze(1)
        if concept_embeddings.ndim != 3:
            raise ValueError("concept_embeddings must have rank 2 or 3")
        concept = self.concept_projection(concept_embeddings)
        count = 1 if deterministic else max(1, samples)
        std = torch.exp(0.5 * logvar)
        if deterministic:
            z_samples = mu.unsqueeze(0)
        else:
            eps = torch.randn(
                count,
                *mu.shape,
                device=mu.device,
                dtype=mu.dtype,
            )
            z_samples = mu.unsqueeze(0) + eps * std.unsqueeze(0)

        probs: list[Tensor] = []
        for z in z_samples:
            expanded_z = z.unsqueeze(1).expand(-1, concept.shape[1], -1)
            joined = torch.cat([expanded_z, concept], dim=-1)
            hidden = self.decoder1(joined)
            delta = _lora_delta(
                joined,
                fast,
                "decoder1",
                self.cfg.lora_rank,
                self.cfg.lora_alpha,
            )
            if delta is not None:
                hidden = hidden + delta
            probs.append(torch.sigmoid(self.decoder2(F.gelu(hidden))).squeeze(-1))
        stacked = torch.stack(probs, dim=0)
        return stacked.mean(dim=0), stacked.std(dim=0, unbiased=False)

    def forward(
        self,
        event_embeddings: Tensor,
        numeric_features: Tensor,
        concept_embeddings: Tensor,
        *,
        lengths: Tensor | None = None,
        fast: FastWeights | None = None,
        samples: int = 1,
    ) -> tuple[Tensor, Tensor, Tensor, Tensor]:
        mu, logvar = self.encode(
            event_embeddings,
            numeric_features,
            lengths=lengths,
            fast=fast,
        )
        mean, uncertainty = self.query(
            mu,
            logvar,
            concept_embeddings,
            fast=fast,
            samples=samples,
            deterministic=samples <= 1,
        )
        return mean, uncertainty, mu, logvar


def load_adapter(
    checkpoint: Path | None = None,
    *,
    device: torch.device | str = "cpu",
    cfg: AdapterConfig | None = None,
) -> tuple[LearnerAdapterModel, bool]:
    """Load a base checkpoint if present, otherwise return seeded weights."""
    model = LearnerAdapterModel(cfg).to(device)
    trained = False
    if checkpoint and checkpoint.exists():
        state = load_file(str(checkpoint), device=str(device))
        missing, unexpected = model.load_state_dict(state, strict=False)
        if unexpected:
            raise ValueError(f"unexpected learner-adapter tensors: {unexpected}")
        # A checkpoint missing only optional/new buffers remains usable; a
        # missing core projection means it is the wrong architecture.
        if "event_projection.weight" in missing:
            raise ValueError("learner-adapter checkpoint is incompatible")
        trained = True
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    return model, trained


def clone_fast_weights(fast: FastWeights) -> dict[str, Tensor]:
    return {
        key: value.detach().clone().requires_grad_(True)
        for key, value in fast.items()
    }

