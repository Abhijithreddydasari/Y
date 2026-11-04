"""H10 command line (from `api`): smoke | optimize | gate | report.

    .venv\\Scripts\\python.exe -m policy_eval.run smoke
    .venv\\Scripts\\python.exe -m policy_eval.run optimize --max-metric-calls 150
    .venv\\Scripts\\python.exe -m policy_eval.run gate --repeats 2
    .venv\\Scripts\\python.exe -m policy_eval.run report

Paid. `--cap` is cumulative for the run directory (`tmp/policy_eval/<run>/calls.jsonl`), so optimize and gate
share one hard cap. Cached rollouts are reused, so rerunning a step after a failure does not pay twice.
"""
from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
from pathlib import Path

from dotenv import load_dotenv

API = Path(__file__).resolve().parents[1]
REPO = API.parent
sys.path.insert(0, str(API))
load_dotenv(REPO / ".env")

from policy_eval import gate, report  # noqa: E402
from policy_eval.budget import BudgetExceeded  # noqa: E402
from policy_eval.runner import PolicyAdapter, Runner, reflection_templates  # noqa: E402
from policy_eval.scenarios import assemble, candidate_hash, load, seed_candidate, split  # noqa: E402

log = logging.getLogger("y.policy_eval")
CAPS = {"smoke": 80, "optimize": 820, "gate": 1100}


def best_from_cache(runner: Runner, val: list) -> tuple[str | None, list[dict]]:
    """Val means of every candidate with full val coverage, from the rollout cache (works after a stopped run)."""
    ids = {s.id for s in val}
    scores: dict[str, dict[str, float]] = {}
    for record in runner.cache.values():
        if record["repeat"] == 0 and record["scenario"] in ids and not record["infra_error"]:
            scores.setdefault(record["candidate"], {})[record["scenario"]] = record["score"]
    rows = [{"hash": h, "val": statistics.fmean(v.values())} for h, v in scores.items() if set(v) == ids]
    rows.sort(key=lambda r: -r["val"])
    return (rows[0]["hash"] if rows else None), rows


def optimize(run_dir: Path, cap: int, max_metric_calls: int, train: list, val: list, minibatch: int) -> dict:
    import gepa

    runner = Runner(run_dir, cap)
    seed = seed_candidate()
    stopped, result = "max_metric_calls", None
    try:
        result = gepa.optimize(seed_candidate=seed, trainset=train, valset=val, adapter=PolicyAdapter(runner, seed),
                               reflection_lm=runner.reflect, reflection_prompt_template=reflection_templates(seed),
                               max_metric_calls=max_metric_calls, reflection_minibatch_size=minibatch,
                               module_selector="round_robin", candidate_selection_strategy="pareto", seed=0,
                               run_dir=str(run_dir / "gepa"), raise_on_exception=True, display_progress_bar=False)
    except BudgetExceeded as exc:
        stopped = f"call cap ({exc})"
        log.warning("stopped: %s", exc)
    info = {"engine": f"gepa {gepa.__version__ if hasattr(gepa, '__version__') else '0.1.4'}",
            "max_metric_calls": max_metric_calls, "stopped": stopped, "train": [s.id for s in train],
            "val": [s.id for s in val]}
    if result is not None:
        hashes = [candidate_hash(c) for c in result.candidates]
        info["candidates"] = [{"hash": h, "val": v, "parent": (p[0] if p and p[0] is not None else None),
                               "at": result.discovery_eval_counts[i] if result.discovery_eval_counts else None}
                              for i, (h, v, p) in enumerate(zip(hashes, result.val_aggregate_scores, result.parents))]
        info["best"] = hashes[result.best_idx]
        info["metric_calls"] = result.total_metric_calls
        for c in result.candidates:
            runner.candidates[candidate_hash(c)] = dict(c)
    else:
        best, rows = best_from_cache(runner, val)
        info["candidates"], info["best"], info["metric_calls"] = rows, best, None
    for h, c in runner.candidates.items():
        (run_dir / "candidates" / f"{h}.json").write_text(json.dumps(c, indent=1), encoding="utf-8")
    info["budget"] = runner.budget.summary()
    (run_dir / "optimize.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
    log.info("best %s; %s", info["best"], runner.budget.summary())
    return info


def load_candidate(run_dir: Path, digest: str | None) -> tuple[str, dict]:
    if digest is None:
        digest = json.loads((run_dir / "optimize.json").read_text(encoding="utf-8"))["best"]
    if digest is None:
        digest = candidate_hash(seed_candidate())
    path = run_dir / "candidates" / f"{digest}.json"
    return digest, (json.loads(path.read_text(encoding="utf-8")) if path.exists() else seed_candidate())


def run_gate(run_dir: Path, cap: int, test: list, repeats: int, digest: str | None) -> dict:
    runner = Runner(run_dir, cap)
    seed = seed_candidate()
    digest, cand = load_candidate(run_dir, digest)
    base, candidate = [], []
    for repeat in range(repeats):
        base += runner.evaluate(seed, test, repeat=repeat, cross=True)
        candidate += runner.evaluate(cand, test, repeat=repeat, cross=True)
    verdict = gate.decide(base, candidate)
    if digest == candidate_hash(seed):
        verdict = {**verdict, "promote": False, "reason": "GEPA found no candidate better than the seed on val"}
    (run_dir / "gate.json").write_text(json.dumps({"candidate": digest, "repeats": repeats, "test": [s.id for s in test],
                                                   "verdict": verdict, "budget": runner.budget.summary()}, indent=1),
                                       encoding="utf-8")
    return verdict


def write_report(run_dir: Path, out_md: Path, out_json: Path, out_candidate: Path | None, title: str) -> None:
    gate_info = json.loads((run_dir / "gate.json").read_text(encoding="utf-8"))
    runner = Runner(run_dir, 10 ** 9)  # reading only; no calls are made
    seed, scenarios = seed_candidate(), load()
    digest, cand = load_candidate(run_dir, gate_info["candidate"])
    ids = set(gate_info["test"])
    seed_hash = candidate_hash(seed)
    base = [r for r in runner.cache.values() if r["candidate"] == seed_hash and r["scenario"] in ids
            and r["repeat"] < gate_info["repeats"]]
    candidate = [r for r in runner.cache.values() if r["candidate"] == digest and r["scenario"] in ids
                 and r["repeat"] < gate_info["repeats"]]
    optimize_path = run_dir / "optimize.json"
    optimize_info = json.loads(optimize_path.read_text(encoding="utf-8")) if optimize_path.exists() else None
    report.write(out_md, out_json, out_candidate, verdict=gate_info["verdict"], baseline=base, candidate=candidate,
                 seed=seed, cand=cand, cand_hash=digest, optimize=optimize_info,
                 budget={**runner.budget.summary(), "cap": gate_info["budget"]["cap"]},
                 scenarios=scenarios, full_prompt=assemble(cand), title=title)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="policy_eval.run")
    parser.add_argument("step", choices=("smoke", "optimize", "gate", "report"))
    parser.add_argument("--run", default=None, help="run directory name under tmp/policy_eval (default: smoke or full)")
    parser.add_argument("--cap", type=int, default=None, help="hard cap on paid attempts for this run directory")
    parser.add_argument("--max-metric-calls", type=int, default=150)
    parser.add_argument("--minibatch", type=int, default=3)
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--candidate", default=None, help="candidate hash for the gate (default: GEPA's best)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    scenarios = load()
    train, val, test = split(scenarios, "train"), split(scenarios, "val"), split(scenarios, "test")
    run_dir = REPO / "tmp" / "policy_eval" / (args.run or ("smoke" if args.step == "smoke" else "full"))
    if args.step == "smoke":
        cap = args.cap or CAPS["smoke"]
        optimize(run_dir, cap, max_metric_calls=6, train=train[:2], val=val[:1], minibatch=2)
        run_gate(run_dir, cap, test[:1], repeats=1, digest=None)
        write_report(run_dir, run_dir / "report.md", run_dir / "report.json", None, "H10 smoke run (not the result)")
        print((run_dir / "report.md").as_posix())
    elif args.step == "optimize":
        optimize(run_dir, args.cap or CAPS["optimize"], args.max_metric_calls, train, val, args.minibatch)
    elif args.step == "gate":
        print(json.dumps(run_gate(run_dir, args.cap or CAPS["gate"], test, args.repeats, args.candidate), indent=1))
    else:
        reports = REPO / "docs" / "reports"
        write_report(run_dir, reports / "H10-policy-eval.md", reports / "H10-policy-eval.json",
                     reports / "H10-candidate-tutor.md", "H10 policy improvement: held-out report")
        print((reports / "H10-policy-eval.md").as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
