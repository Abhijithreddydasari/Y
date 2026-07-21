"""Prequential benchmark for heuristics, BKT, DKT, and Level-2 adaptation."""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))
from learner_adapter import AdapterConfig, clone_fast_weights, load_adapter  # noqa: E402
from embedding import FrozenEmbedder, hash_embedding  # noqa: E402

ADAPTER_EMBEDDER: FrozenEmbedder | None = None


def score(event: dict) -> float:
    return float(event["outcome"]["correct"]) + 0.5 * float(event["outcome"]["partial"])


def numeric(event: dict) -> list[float]:
    outcome = event["outcome"]
    return [outcome["correct"], outcome["partial"], outcome["incorrect"], event["independence"], event["evidence_strength"], 1, 0, min(1, len(event["item"]["concepts"]) / 6)]


def event_embedding(event: dict, width: int) -> list[float]:
    text = f"concept={event['concept']}; question={event['item']['prompt']}; response={event['response_summary']}; misconception={event['misconception'] or 'none'}"
    if ADAPTER_EMBEDDER is None:
        raise RuntimeError("adapter embedder is not initialized")
    return list(ADAPTER_EMBEDDER("search_document: " + text))


def histories_batch(records: list[tuple[list[dict], dict]], cfg: AdapterConfig, device: torch.device):
    time = max(1, max(len(history) for history, _ in records))
    events = torch.zeros(len(records), time, cfg.embedding_dim, device=device)
    features = torch.zeros(len(records), time, cfg.numeric_dim, device=device)
    lengths = torch.ones(len(records), dtype=torch.long, device=device)
    concepts = torch.zeros(len(records), cfg.embedding_dim, device=device)
    labels = torch.zeros(len(records), device=device)
    weights = torch.zeros(len(records), device=device)
    for row, (history, target) in enumerate(records):
        history = history[-cfg.max_events:]
        if history:
            lengths[row] = len(history)
            events[row, :len(history)] = torch.tensor([event_embedding(event, cfg.embedding_dim) for event in history], device=device)
            features[row, :len(history)] = torch.tensor([numeric(event) for event in history], device=device)
        if ADAPTER_EMBEDDER is None:
            raise RuntimeError("adapter embedder is not initialized")
        concepts[row] = torch.tensor(ADAPTER_EMBEDDER(f"search_query: {target['concept']}"), device=device)
        labels[row] = score(target)
        weights[row] = float(target["evidence_strength"]) * max(0.25, float(target["independence"]))
    return events, features, lengths, concepts, labels, weights


def adapter_loss(model, records, fast, cfg, device):
    events, features, lengths, concepts, labels, weights = histories_batch(records, cfg, device)
    predictions, _, _, _ = model(events, features, concepts, lengths=lengths, fast=fast, samples=1)
    losses = F.binary_cross_entropy(predictions.squeeze(1).clamp(1e-5, 1 - 1e-5), labels, reduction="none")
    return (losses * weights).sum() / weights.sum().clamp_min(1e-6)


def adapter_prediction(model, history, target, fast, cfg, device, samples: int) -> tuple[float, float]:
    events, features, lengths, concepts, _, _ = histories_batch([(history, target)], cfg, device)
    with torch.no_grad():
        mean, uncertainty, _, _ = model(events, features, concepts, lengths=lengths, fast=fast, samples=samples)
    return float(mean.item()), float(uncertainty.item())


def representation_batch(history: list[dict], cfg: AdapterConfig, device: torch.device, seed: int):
    """Two deterministic masked/noisy views for representation-only TTA."""
    history = history[-cfg.max_events:]
    clean = torch.tensor(
        [[event_embedding(event, cfg.embedding_dim) for event in history]],
        dtype=torch.float32,
        device=device,
    )
    features = torch.tensor(
        [[numeric(event) for event in history]], dtype=torch.float32, device=device,
    )
    lengths = torch.tensor([len(history)], dtype=torch.long, device=device)
    generator = torch.Generator(device=device)
    generator.manual_seed(seed)

    def noisy():
        keep = (torch.rand(clean.shape, generator=generator, device=device) > 0.08).to(clean.dtype)
        noise = torch.randn(clean.shape, generator=generator, device=device) * 0.01
        return clean * keep + noise

    return clean, noisy(), noisy(), features, lengths


def representation_loss(model, batch, fast, target_mu, target_logvar):
    _, first, second, features, lengths = batch
    mu_a, logvar_a = model.encode(first, features, lengths=lengths, fast=fast)
    mu_b, logvar_b = model.encode(second, features, lengths=lengths, fast=fast)
    return (
        2
        - F.cosine_similarity(mu_a, target_mu, dim=-1).mean()
        - F.cosine_similarity(mu_b, target_mu, dim=-1).mean()
        + 0.05 * (F.mse_loss(logvar_a, target_logvar) + F.mse_loss(logvar_b, target_logvar))
    )


class HashDKT(nn.Module):
    def __init__(self, width: int = 32, hidden: int = 64) -> None:
        super().__init__()
        self.width = width
        self.cell = nn.LSTMCell(width + 2, hidden)
        self.query = nn.Linear(width, hidden)

    def predict(self, concept: str, state: tuple[torch.Tensor, torch.Tensor]) -> torch.Tensor:
        query = torch.tensor([hash_embedding(concept, self.width)], dtype=torch.float32)
        return torch.sigmoid((state[0] * self.query(query)).sum(-1) / math.sqrt(state[0].shape[-1]))

    def observe(self, event: dict, state: tuple[torch.Tensor, torch.Tensor]):
        value = hash_embedding(event["concept"], self.width) + [score(event), float(event["evidence_strength"])]
        return self.cell(torch.tensor([value], dtype=torch.float32), state)


def train_dkt(trajectories: list[list[dict]], epochs: int = 3) -> HashDKT:
    model = HashDKT()
    optimiser = torch.optim.AdamW(model.parameters(), lr=2e-3)
    for _ in range(epochs):
        random.shuffle(trajectories)
        for events in trajectories:
            state = (torch.zeros(1, 64), torch.zeros(1, 64))
            losses = []
            for event in events:
                if event["split"] != "train":
                    continue
                prediction = model.predict(event["concept"], state)
                losses.append(F.binary_cross_entropy(prediction, torch.tensor([score(event)])))
                state = model.observe(event, state)
            if losses:
                optimiser.zero_grad(set_to_none=True)
                torch.stack(losses).mean().backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimiser.step()
    return model.eval()


def ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=values.__getitem__)
    result = [0.0] * len(values)
    for rank, index in enumerate(order):
        result[index] = float(rank)
    return result


def spearman(a: list[float], b: list[float]) -> float:
    if len(a) < 2:
        return 0.0
    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    numerator = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    denominator = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return numerator / denominator if denominator else 0.0


def auroc(labels: list[int], predictions: list[float]) -> float:
    positives = [i for i, value in enumerate(labels) if value]
    negatives = [i for i, value in enumerate(labels) if not value]
    if not positives or not negatives:
        return 0.5
    wins = sum((predictions[p] > predictions[n]) + 0.5 * (predictions[p] == predictions[n]) for p in positives for n in negatives)
    return wins / (len(positives) * len(negatives))


def metrics(rows: list[dict]) -> dict:
    probabilities = [min(1 - 1e-6, max(1e-6, row["prediction"])) for row in rows]
    soft = [row["target"] for row in rows]
    binary = [int(value >= 0.5) for value in soft]
    losses = [-(target * math.log(p) + (1 - target) * math.log(1 - p)) for target, p in zip(soft, probabilities)]
    bins = [[] for _ in range(10)]
    for target, p in zip(soft, probabilities):
        bins[min(9, int(p * 10))].append((target, p))
    ece = sum(len(bucket) / max(1, len(rows)) * abs(sum(t for t, _ in bucket) / len(bucket) - sum(p for _, p in bucket) / len(bucket)) for bucket in bins if bucket)
    early = [loss for loss, row in zip(losses, rows) if row["turn"] < 3]
    midpoint = max(1, len(losses) // 2)
    return {
        "n": len(rows), "auroc": auroc(binary, probabilities),
        "log_loss": sum(losses) / max(1, len(losses)),
        "brier": sum((p - target) ** 2 for p, target in zip(probabilities, soft)) / max(1, len(rows)),
        "ece_10": ece, "hidden_state_spearman": spearman(probabilities, [row["hidden"] for row in rows]),
        "cold_start_log_loss": sum(early) / max(1, len(early)),
        "adaptation_gain_over_turns": sum(losses[:midpoint]) / midpoint - sum(losses[midpoint:]) / max(1, len(losses) - midpoint),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=ROOT / "training" / "data" / "learner_trajectories.jsonl")
    parser.add_argument("--checkpoint", type=Path, default=ROOT / "models" / "learner-adapter-v1.safetensors")
    parser.add_argument("--output", type=Path, default=ROOT / "training" / "evaluation.json")
    parser.add_argument("--max-learners", type=int, default=100)
    parser.add_argument("--dkt-epochs", type=int, default=3)
    parser.add_argument("--embedder", choices=["nomic", "hash"], default="nomic")
    args = parser.parse_args()
    trajectories = [json.loads(line)["events"] for line in args.data.read_text(encoding="utf-8").splitlines() if line.strip()][:args.max_learners]
    dkt = train_dkt(trajectories, args.dkt_epochs)
    cfg = AdapterConfig()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    global ADAPTER_EMBEDDER
    ADAPTER_EMBEDDER = FrozenEmbedder(args.embedder, str(device))
    model, trained = load_adapter(args.checkpoint, device=device, cfg=cfg)
    predictions: dict[str, list[dict]] = {name: [] for name in ["heuristic", "bkt", "dkt_lstm", "frozen_adapter", "adapter_without_uncertainty", "full_level2"]}
    mastery_rollbacks = mastery_updates = 0
    representation_rollbacks = representation_updates = 0
    for learner_index, events in enumerate(trajectories):
        averages: dict[str, list[float]] = {}
        bkt: dict[str, float] = {}
        dkt_state = (torch.zeros(1, 64), torch.zeros(1, 64))
        history: list[dict] = []
        records: list[tuple[list[dict], dict]] = []
        fast = model.init_fast_weights(device=device)
        for event in events:
            concept = event["concept"]
            base = sum(averages.get(concept, [0.5])) / len(averages.get(concept, [0.5]))
            prior = bkt.get(concept, 0.5)
            dkt_probability = float(dkt.predict(concept, dkt_state).item())
            frozen, _ = adapter_prediction(model, history, event, None, cfg, device, 16)
            deterministic, _ = adapter_prediction(model, history, event, fast, cfg, device, 1)
            adapted, uncertainty = adapter_prediction(model, history, event, fast, cfg, device, 16)
            common = {"target": score(event), "hidden": event["hidden_mastery_before"], "turn": event["turn"], "split": event["split"]}
            for name, value in [("heuristic", base), ("bkt", prior), ("dkt_lstm", dkt_probability), ("frozen_adapter", frozen), ("adapter_without_uncertainty", deterministic), ("full_level2", adapted)]:
                predictions[name].append({**common, "prediction": value, "uncertainty": uncertainty if name == "full_level2" else 0})
            observed = score(event)
            averages.setdefault(concept, []).append(observed)
            likelihood_correct = prior * (0.85 if observed >= 0.5 else 0.15)
            likelihood_wrong = (1 - prior) * (0.2 if observed >= 0.5 else 0.8)
            posterior = likelihood_correct / max(1e-6, likelihood_correct + likelihood_wrong)
            bkt[concept] = posterior + (1 - posterior) * 0.08
            dkt_state = tuple(value.detach() for value in dkt.observe(event, dkt_state))
            records.append((list(history), event))
            history.append(event)
            # Speed 1: every observation updates encoder LoRA using no labels.
            rep_batch = representation_batch(
                history, cfg, device, seed=17 + learner_index * 1000 + int(event["turn"])
            )
            clean, _, _, rep_features, rep_lengths = rep_batch
            with torch.no_grad():
                target_mu, target_logvar = model.encode(
                    clean, rep_features, lengths=rep_lengths, fast=fast
                )
                rep_before_loss = float(representation_loss(
                    model, rep_batch, fast, target_mu, target_logvar
                ).item())
            rep_keys = [key for key in fast if key.startswith("blocks.")]
            rep_before = {key: fast[key].detach().clone().requires_grad_(True) for key in rep_keys}
            rep_optimiser = torch.optim.AdamW([fast[key] for key in rep_keys], lr=2e-4)
            rep_optimiser.zero_grad(set_to_none=True)
            rep_loss = representation_loss(model, rep_batch, fast, target_mu, target_logvar)
            rep_loss.backward()
            torch.nn.utils.clip_grad_norm_([fast[key] for key in rep_keys], 0.5)
            rep_optimiser.step()
            with torch.no_grad():
                rep_after_loss = float(representation_loss(
                    model, rep_batch, fast, target_mu, target_logvar
                ).item())
            representation_updates += 1
            if not math.isfinite(rep_after_loss) or rep_after_loss > rep_before_loss * 1.05:
                fast.update(rep_before)
                representation_rollbacks += 1

            # Speed 2: trustworthy assessed evidence additionally tunes the
            # query decoder and encoder over replay.
            if event["evidence_strength"] >= 0.65:
                batch = records[-16:]
                before = clone_fast_weights(fast)
                with torch.no_grad():
                    before_loss = float(adapter_loss(model, batch, fast, cfg, device).item())
                optimiser = torch.optim.AdamW(fast.values(), lr=1e-3)
                for _ in range(3):
                    optimiser.zero_grad(set_to_none=True)
                    loss = adapter_loss(model, batch, fast, cfg, device)
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(list(fast.values()), 1.0)
                    optimiser.step()
                with torch.no_grad():
                    after_loss = float(adapter_loss(model, batch, fast, cfg, device).item())
                mastery_updates += 1
                if not math.isfinite(after_loss) or after_loss > before_loss * 1.05:
                    fast = before
                    mastery_rollbacks += 1
    report = {
        "checkpoint_trained": trained,
        "device": str(device),
        "embedding_backend": args.embedder,
        "models": {},
    }
    for name, rows in predictions.items():
        report["models"][name] = {
            "all": metrics(rows),
            "held_out_concept": metrics([row for row in rows if row["split"] == "test_concept"]),
            "held_out_domain": metrics([row for row in rows if row["split"] == "test_domain"]),
        }
    report["full_level2_update_guard"] = {
        "representation": {
            "updates": representation_updates,
            "rollbacks": representation_rollbacks,
            "rollback_rate": representation_rollbacks / max(1, representation_updates),
        },
        "mastery": {
            "updates": mastery_updates,
            "rollbacks": mastery_rollbacks,
            "rollback_rate": mastery_rollbacks / max(1, mastery_updates),
        },
    }
    frozen = report["models"]["frozen_adapter"]
    full = report["models"]["full_level2"]
    held_out_beats_frozen = all(
        full[split]["log_loss"] < frozen[split]["log_loss"]
        for split in ("held_out_concept", "held_out_domain")
    )
    calibration_ok = full["all"]["ece_10"] <= frozen["all"]["ece_10"] + 0.02
    rollback_ok = all(
        report["full_level2_update_guard"][kind]["rollback_rate"] <= 0.25
        for kind in ("representation", "mastery")
    )
    report["promotion_gate"] = {
        "passed": bool(trained and held_out_beats_frozen and calibration_ok and rollback_ok),
        "checkpoint_trained": trained,
        "held_out_beats_frozen": held_out_beats_frozen,
        "calibration_ok": calibration_ok,
        "rollback_ok": rollback_ok,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
