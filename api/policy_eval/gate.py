"""Promotion gate on the held-out split: paired baseline vs candidate, with a bootstrap interval."""
from __future__ import annotations

import random
import statistics

from . import score

MIN_GAIN = 0.05
MAX_VALID_DROP = 0.02


def paired(baseline: list[dict], candidate: list[dict]) -> list[tuple[dict, dict]]:
    """Pairs on (scenario, repeat); a pair with an infrastructure failure on either side is left out of both arms."""
    base = {(r["scenario"], r["repeat"]): r for r in baseline}
    out = []
    for r in candidate:
        b = base.get((r["scenario"], r["repeat"]))
        if b and not b["infra_error"] and not r["infra_error"]:
            out.append((b, r))
    return out


def cross_score(record: dict) -> float | None:
    """The same total with gpt-6-luna's rubric in place of the primary judge's."""
    cross = record.get("cross") or {}
    if not record["parts"] or any(k not in cross for k in score.RUBRIC):
        return None
    judge = sum((cross[k] - 1) / 4 for k in score.RUBRIC) / len(score.RUBRIC)
    return score.total({**record["parts"], "judge": judge})


def bootstrap(diffs_by_scenario: dict[str, list[float]], draws: int = 2000, seed: int = 0) -> tuple[float, float]:
    """90% interval of the mean difference, resampling scenarios (repeats stay together)."""
    keys = sorted(diffs_by_scenario)
    if not keys:
        return 0.0, 0.0
    means = {k: statistics.fmean(v) for k, v in diffs_by_scenario.items()}
    rng = random.Random(seed)
    stats = sorted(statistics.fmean(means[rng.choice(keys)] for _ in keys) for _ in range(draws))
    return stats[int(0.05 * draws)], stats[int(0.95 * draws) - 1]


def decide(baseline: list[dict], candidate: list[dict]) -> dict:
    pairs = paired(baseline, candidate)
    if not pairs:
        return {"promote": False, "reason": "no complete held-out pairs", "pairs": 0}
    base = statistics.fmean(b["score"] for b, _ in pairs)
    cand = statistics.fmean(c["score"] for _, c in pairs)
    valid_base = statistics.fmean(b["parts"]["valid"] for b, _ in pairs)
    valid_cand = statistics.fmean(c["parts"]["valid"] for _, c in pairs)
    by_scenario: dict[str, list[float]] = {}
    for b, c in pairs:
        by_scenario.setdefault(c["scenario"], []).append(c["score"] - b["score"])
    lo, hi = bootstrap(by_scenario)
    gain = cand - base
    reasons = []
    if gain < MIN_GAIN - 1e-9:
        reasons.append(f"held-out gain {gain:+.3f} is below {MIN_GAIN}")
    if valid_cand < valid_base - MAX_VALID_DROP - 1e-9:
        reasons.append(f"valid rate fell {valid_base:.3f} → {valid_cand:.3f}")
    parts = {k: {"baseline": statistics.fmean(b["parts"][k] for b, _ in pairs if b["parts"][k] is not None)
                 if any(b["parts"][k] is not None for b, _ in pairs) else None,
                 "candidate": statistics.fmean(c["parts"][k] for _, c in pairs if c["parts"][k] is not None)
                 if any(c["parts"][k] is not None for _, c in pairs) else None}
             for k in score.WEIGHTS}
    crosses = [(cross_score(b), cross_score(c)) for b, c in pairs]
    crosses = [(x, y) for x, y in crosses if x is not None and y is not None]
    cross = None
    if crosses:
        cross = {"pairs": len(crosses), "baseline": statistics.fmean(x for x, _ in crosses),
                 "candidate": statistics.fmean(y for _, y in crosses)}
        cross["gain"] = cross["candidate"] - cross["baseline"]
        cross["agrees"] = (cross["gain"] >= MIN_GAIN) == (gain >= MIN_GAIN)
    return {"promote": not reasons, "reason": "; ".join(reasons) or f"held-out gain {gain:+.3f} ≥ {MIN_GAIN}",
            "pairs": len(pairs), "excluded": len(candidate) - len(pairs), "baseline": base, "candidate": cand,
            "gain": gain, "interval90": [lo, hi], "interval_excludes_zero": lo > 0 or hi < 0,
            "valid": {"baseline": valid_base, "candidate": valid_cand}, "parts": parts, "cross_judge": cross,
            "per_scenario": {k: statistics.fmean(v) for k, v in sorted(by_scenario.items())}}
