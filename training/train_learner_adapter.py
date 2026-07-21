"""Train the global 9.43M learner adapter on synthetic trajectories.

The script is GPU/Modal friendly, uses mixed precision when CUDA is present,
splits prequentially, early-stops on validation log loss, and writes a
safetensors checkpoint plus reproducibility metadata.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sys
from pathlib import Path

import torch
from safetensors.torch import save_file
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
from learner_adapter import AdapterConfig, LearnerAdapterModel  # noqa: E402
from embedding import FrozenEmbedder  # noqa: E402


def numeric(event: dict) -> list[float]:
    outcome = event["outcome"]
    return [
        float(outcome["correct"]), float(outcome["partial"]), float(outcome["incorrect"]),
        float(event["independence"]), float(event["evidence_strength"]), 1.0, 0.0,
        min(1.0, len(event["item"].get("concepts", [])) / 6),
    ]


def event_text(event: dict) -> str:
    item = event["item"]
    return (
        f"concept={event['concept']}; question={item['prompt']}; "
        f"response={event['response_summary']}; misconception={event['misconception'] or 'none'}"
    )


class PrequentialDataset(Dataset):
    def __init__(self, path: Path, split: str, max_events: int, smoke_limit: int = 0) -> None:
        self.rows: list[dict] = []
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                trajectory = json.loads(line)
                events = trajectory["events"]
                for index, target in enumerate(events):
                    if target["split"] != split:
                        continue
                    history = events[max(0, index - max_events):index]
                    self.rows.append({"history": history, "target": target})
                    if smoke_limit and len(self.rows) >= smoke_limit:
                        return

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict:
        return self.rows[index]


def collate(rows: list[dict], cfg: AdapterConfig, embedder: FrozenEmbedder) -> tuple[torch.Tensor, ...]:
    time = max(1, max(len(row["history"]) for row in rows))
    events = torch.zeros(len(rows), time, cfg.embedding_dim)
    features = torch.zeros(len(rows), time, cfg.numeric_dim)
    lengths = torch.ones(len(rows), dtype=torch.long)
    concepts = torch.zeros(len(rows), cfg.embedding_dim)
    targets = torch.zeros(len(rows))
    weights = torch.zeros(len(rows))
    for i, row in enumerate(rows):
        history = row["history"]
        if history:
            lengths[i] = len(history)
            events[i, :len(history)] = torch.tensor([embedder("search_document: " + event_text(event)) for event in history])
            features[i, :len(history)] = torch.tensor([numeric(event) for event in history])
        target = row["target"]
        concepts[i] = torch.tensor(embedder(f"search_query: {target['concept']}"))
        targets[i] = float(target["hidden_mastery_before"])
        weights[i] = float(target["evidence_strength"])
    return events, features, lengths, concepts, targets, weights


def loss_for(model: LearnerAdapterModel, batch: tuple[torch.Tensor, ...], device: torch.device) -> torch.Tensor:
    events, features, lengths, concepts, targets, weights = (value.to(device) for value in batch)
    prediction, _, mu, logvar = model(events, features, concepts, lengths=lengths, samples=1)
    # The decoder intentionally returns calibrated probabilities rather than
    # logits. Probability-form BCE is unsafe in CUDA autocast, so keep the
    # expensive model forward mixed-precision and evaluate this small loss
    # boundary in float32.
    with torch.autocast(device_type=device.type, enabled=False):
        bce = F.binary_cross_entropy(
            prediction.float().squeeze(1).clamp(1e-5, 1 - 1e-5),
            targets.float(),
            reduction="none",
        )
    fit = (bce * weights).sum() / weights.sum().clamp_min(1e-6)
    kl = -0.5 * torch.mean(1 + logvar - mu.square() - logvar.exp())
    return fit + 1e-4 * kl


@torch.no_grad()
def validate(model: LearnerAdapterModel, loader: DataLoader, device: torch.device) -> float:
    model.eval()
    losses = [float(loss_for(model, batch, device).item()) for batch in loader]
    return sum(losses) / max(1, len(losses))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ROOT / "training" / "data" / "learner_trajectories.jsonl")
    parser.add_argument("--output", type=Path, default=ROOT / "models" / "learner-adapter-v1.safetensors")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--smoke-limit", type=int, default=0)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--embedder", choices=["nomic", "hash"], default="nomic")
    args = parser.parse_args()
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    cfg = AdapterConfig()
    train_data = PrequentialDataset(args.data, "train", cfg.max_events, args.smoke_limit)
    val_data = PrequentialDataset(args.data, "validation", cfg.max_events, args.smoke_limit)
    if not train_data or not val_data:
        raise SystemExit("Corpus needs non-empty train and validation splits; increase --learners")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    embedder = FrozenEmbedder(args.embedder, str(device))
    train_loader = DataLoader(train_data, batch_size=args.batch_size, shuffle=True, collate_fn=lambda rows: collate(rows, cfg, embedder))
    val_loader = DataLoader(val_data, batch_size=args.batch_size, collate_fn=lambda rows: collate(rows, cfg, embedder))
    model = LearnerAdapterModel(cfg).to(device)
    optimiser = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    best_loss, best_state, stale = math.inf, None, 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for batch in train_loader:
            optimiser.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                loss = loss_for(model, batch, device)
            scaler.scale(loss).backward()
            scaler.unscale_(optimiser)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimiser)
            scaler.update()
        val_loss = validate(model, val_loader, device)
        print(json.dumps({"epoch": epoch, "validation_prequential_log_loss": val_loss}))
        if val_loss < best_loss - 1e-4:
            best_loss = val_loss
            best_state = {key: value.detach().cpu().contiguous() for key, value in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
            if stale >= args.patience:
                break
    if best_state is None:
        raise SystemExit("Training produced no checkpoint")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    save_file(best_state, str(args.output))
    data_hash = hashlib.sha256(args.data.read_bytes()).hexdigest()
    config = {
        "adapter": cfg.to_dict(), "parameter_count": model.parameter_count,
        "best_validation_prequential_log_loss": best_loss,
        "data_sha256": data_hash, "seed": args.seed,
        "device": str(device), "torch": torch.__version__,
        "embedding_backend": args.embedder,
    }
    config_path = args.output.with_suffix(".config.json")
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(json.dumps({"checkpoint": str(args.output), "config": str(config_path), **config}, indent=2))


if __name__ == "__main__":
    main()
