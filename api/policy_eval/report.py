"""The H10 report: gate verdict, per-scenario table, policy diff, Meta prompt/response examples and spend."""
from __future__ import annotations

import difflib
import json
from pathlib import Path

from .gate import cross_score
from .rollout import board_lines
from .scenarios import EVOLVED
from .score import RUBRIC, WEIGHTS

# Muse Spark 1.3 rates given by the user on 2026-11-03 (USD per million tokens).
SPARK_RATES = {"input": 1.25, "cached": 0.15, "output": 4.25}
ROLE_NAMES = {"tutor": "Tutor turns", "tutor_repair": "Tutor move repairs", "reflect": "GEPA reflection (policy rewrite)",
              "student": "Simulated student", "judge": "Rubric judge", "cross_judge": "Cross-judge (held-out only)"}
MODEL_NAMES = {"muse-spark-1.3": "Muse Spark 1.3 (Meta)", "meta-models/muse-spark-open-1026": "Muse Spark Open on Baseten (Meta)",
               "gpt-6-luna": "gpt-6-luna (OpenAI Decisions)"}


def spark_cost(tokens: dict) -> float:
    cached = tokens.get("cached_tokens", 0)
    fresh = max(0, tokens.get("input_tokens", 0) - cached)
    return (fresh * SPARK_RATES["input"] + cached * SPARK_RATES["cached"]
            + tokens.get("output_tokens", 0) * SPARK_RATES["output"]) / 1e6


def spend(budget: dict) -> tuple[list[dict], float]:
    rows, total = [], 0.0
    for key, tokens in sorted(budget["tokens"].items()):
        role, model = key.split("|", 1)
        cost = spark_cost(tokens) if model == "muse-spark-1.3" else None
        total += cost or 0.0
        rows.append({"role": role, "model": model, "calls": None, **tokens, "usd": cost})
    calls = budget["by_role"]
    for row in rows:
        row["calls"] = calls.get(row["role"])
    return rows, total


def _diff(seed: dict, cand: dict) -> str:
    out = []
    for name in EVOLVED:
        lines = list(difflib.unified_diff(seed[name].splitlines(), cand[name].splitlines(), f"tutor-v1 {name}",
                                          f"candidate {name}", lineterm="", n=1))
        out.append(f"#### `{name}`\n\n" + ("```diff\n" + "\n".join(lines) + "\n```" if lines else "_unchanged_"))
    return "\n\n".join(out)


def _turn_block(record: dict) -> str:
    lines = []
    for i, turn in enumerate(record["turns"]):
        answer = record["answers"][i] if i < len(record["answers"]) else None
        lines.append(f"**Turn {i + 1}** ({turn['status']}, {len(turn['moves'])} moves, {len(turn['dropped'])} dropped)")
        lines += [f"> {line}" for line in board_lines(turn["moves"])[:14]]
        q = next((m for m in turn["moves"] if m["type"] in ("check", "predict")), None)
        if q:
            lines.append(f"> **{q['type']}:** {q['q']} — options {q['options']} — key `{q.get('key', q.get('answer'))}`")
        if answer:
            lines.append(f"Student (Spark Open): `{answer['answer']}` → {answer['result']}"
                         f"{' (still holds the belief)' if answer.get('still_believes') else ''}")
        lines.append("")
    rubric = record.get("rubric") or {}
    if rubric:
        lines.append("Judge (Spark Open): " + ", ".join(f"{k} {rubric[k]}" for k in RUBRIC)
                     + f". _{rubric.get('critique', '')}_")
    return "\n".join(lines)


def _prompt_excerpt(record: dict) -> str:
    """The tail of what Muse Spark 1.3 read on turn 2: this turn, with the student's answer."""
    if len(record["turns"]) < 2:
        return ""
    user = record["turns"][1]["user"]
    tail = user[user.rfind("THIS TURN"):] if "THIS TURN" in user else user[-1200:]
    return "```\n" + tail[:1500] + "\n```"


def write(out_md: Path, out_json: Path, out_candidate: Path | None, *, verdict: dict, baseline: list[dict],
          candidate: list[dict], seed: dict, cand: dict, cand_hash: str, optimize: dict | None, budget: dict,
          scenarios: list, full_prompt: str | None, title: str) -> None:
    rows, usd = spend(budget)
    by_id = {s.id: s for s in scenarios}
    base_by = {(r["scenario"], r["repeat"]): r for r in baseline}
    table = ["| Scenario | Kind | Baseline | Candidate | Δ | Judge b→c | Resolved b→c | Probe b→c | Valid b→c |",
             "|---|---|---|---|---|---|---|---|---|"]
    pairs = []
    for r in sorted(candidate, key=lambda r: (r["scenario"], r["repeat"])):
        b = base_by.get((r["scenario"], r["repeat"]))
        if not b:
            continue
        pairs.append((b, r))
        if b["infra_error"] or r["infra_error"]:
            table.append(f"| {r['scenario']} #{r['repeat']} | {r['kind']} | excluded: {b['infra_error'] or r['infra_error']} | | | | | | |")
            continue
        def f(rec, k):
            v = rec["parts"][k]
            return "–" if v is None else f"{v:.2f}"
        table.append(f"| {r['scenario']} #{r['repeat']} | {r['kind']} | {b['score']:.3f} | {r['score']:.3f} | "
                     f"{r['score'] - b['score']:+.3f} | {f(b, 'judge')}→{f(r, 'judge')} | {f(b, 'resolved')}→{f(r, 'resolved')} | "
                     f"{f(b, 'probe')}→{f(r, 'probe')} | {f(b, 'valid')}→{f(r, 'valid')} |")
    complete = [(b, r) for b, r in pairs if not b["infra_error"] and not r["infra_error"]]
    picks = sorted(complete, key=lambda p: p[1]["score"] - p[0]["score"])
    examples = []
    if picks:
        chosen = [picks[-1]] + ([picks[0]] if len(picks) > 1 else []) + ([picks[len(picks) // 2]] if len(picks) > 2 else [])
        seen = set()
        for b, r in chosen:
            if (r["scenario"], r["repeat"]) in seen:
                continue
            seen.add((r["scenario"], r["repeat"]))
            s = by_id[r["scenario"]]
            examples.append(
                f"### {s.id} (repeat {r['repeat']}): Δ {r['score'] - b['score']:+.3f}\n\n"
                f"Hidden belief: _{s.belief}_. Student asks: “{s.question}”\n\n"
                f"#### Baseline `tutor-v1` (score {b['score']:.3f})\n\n{_turn_block(b)}\n\n"
                f"What Muse Spark 1.3 read on turn 2 (end of the user message):\n\n{_prompt_excerpt(b)}\n\n"
                f"#### Candidate `{cand_hash}` (score {r['score']:.3f})\n\n{_turn_block(r)}\n")
    gate_lines = [f"- **Verdict: {'PROMOTE (gate passed; not wired in)' if verdict.get('promote') else 'DO NOT PROMOTE'}**: "
                  f"{verdict.get('reason')}."]
    if verdict.get("pairs"):
        lo, hi = verdict["interval90"]
        gate_lines += [
            f"- Held-out mean: baseline **{verdict['baseline']:.3f}**, candidate **{verdict['candidate']:.3f}**, "
            f"gain **{verdict['gain']:+.3f}** over {verdict['pairs']} paired rollouts ({verdict['excluded']} excluded for "
            "infrastructure failures).",
            f"- 90% bootstrap interval of the gain (resampling scenarios): [{lo:+.3f}, {hi:+.3f}]; "
            f"{'excludes' if verdict['interval_excludes_zero'] else 'includes'} 0.",
            f"- Move valid rate: {verdict['valid']['baseline']:.3f} → {verdict['valid']['candidate']:.3f}.",
        ]
        cross = verdict.get("cross_judge")
        if cross:
            gate_lines.append(f"- Cross-judge (gpt-6-luna rubric in place of Spark Open's): {cross['baseline']:.3f} → "
                              f"{cross['candidate']:.3f} ({cross['gain']:+.3f}) over {cross['pairs']} pairs; "
                              f"{'agrees' if cross['agrees'] else 'disagrees'} with the primary verdict.")
    parts_table = ["| Part | Weight | Baseline | Candidate |", "|---|---|---|---|"]
    for k, w in WEIGHTS.items():
        p = (verdict.get("parts") or {}).get(k) or {}
        fmt = lambda v: "–" if v is None else f"{v:.3f}"
        parts_table.append(f"| {k} | {w:.2f} | {fmt(p.get('baseline'))} | {fmt(p.get('candidate'))} |")
    spend_table = ["| Role | Model | Calls | Input tokens | Cached | Output tokens | Reasoning | Cost |",
                   "|---|---|---|---|---|---|---|---|"]
    for row in rows:
        spend_table.append(f"| {ROLE_NAMES.get(row['role'], row['role'])} | {MODEL_NAMES.get(row['model'], row['model'])} | "
                           f"{row['calls'] or 0} | {row.get('input_tokens', 0):,} | {row.get('cached_tokens', 0):,} | "
                           f"{row.get('output_tokens', 0):,} | {row.get('reasoning_tokens', 0):,} | "
                           f"{'$%.2f' % row['usd'] if row['usd'] is not None else 'rate not known'} |")
    trajectory = ""
    if optimize:
        lines = ["| # | Candidate | Parent | Val mean | Found at metric call |", "|---|---|---|---|---|"]
        for i, c in enumerate(optimize.get("candidates", [])):
            lines.append(f"| {i} | `{c['hash']}` | {c.get('parent')} | {c['val']:.3f} | {c.get('at')} |")
        trajectory = (f"GEPA {optimize.get('engine', '')}: {optimize.get('metric_calls')} metric calls "
                      f"(cap {optimize.get('max_metric_calls')}), stopped by {optimize.get('stopped')}. "
                      f"Best on val: `{optimize.get('best')}`.\n\n" + "\n".join(lines))
    md = f"""# {title}

Generated by `api/policy_eval` (`python -m policy_eval.run report`). The live tutor prompt
(`api/prompts/tutor-v1.md`) was not changed. Every number below comes from live, paid calls unless marked.

## Gate (held-out scenarios the optimiser never saw)

{chr(10).join(gate_lines)}

Rule: promote only if the held-out mean gain is at least 0.05 and the move valid rate falls by no more than 0.02.

{chr(10).join(parts_table)}

## Per held-out rollout

{chr(10).join(table)}

## Where Meta models do the work

| Job | Model |
|---|---|
| Tutor, baseline and candidate (real `TurnRun` path: strict JSON moves, validator, repairs) | Muse Spark 1.3, `minimal` |
| Rewriting the policy (GEPA reflection) | Muse Spark 1.3, `medium` |
| Simulated student holding the hidden misconception | Muse Spark Open on Baseten, `low` |
| Rubric judge and critique that GEPA learns from | Muse Spark Open on Baseten, `low` |
| Cross-judge on held-out only (independent family) | gpt-6-luna, OpenAI Decisions |

## GEPA trajectory

{trajectory or '_No optimisation record._'}

## What GEPA changed (seed → candidate `{cand_hash}`)

{_diff(seed, cand)}

## Examples: the same held-out scenario, baseline against candidate

{chr(10).join(examples) or '_No complete pairs._'}

## Spend

{chr(10).join(spend_table)}

Total paid attempts: {budget['used']} (cap {budget['cap']}). Muse Spark 1.3 cost at $1.25 / $0.15 cached / $4.25 per
million tokens: **${usd:.2f}**. Baseten and OpenAI rates are not known here; their token counts are listed.

## Caveats

- Tutor, student and judge are Meta models of one family; deterministic parts carry 65% of the score, and
  gpt-6-luna re-judges the held-out set.
- The student is simulated. A gain here is evidence that the policy teaches simulated misconceptions better, not
  a learning gain in people.
- Muse Spark is not deterministic at `minimal` effort; each held-out scenario ran {max((r['repeat'] for r in candidate), default=0) + 1} time(s) per arm.
- Marker-based parts (probe, addresses) are coarse phrase matches, authored per scenario.
"""
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md, encoding="utf-8")
    out_json.write_text(json.dumps({"title": title, "verdict": verdict, "candidate_hash": cand_hash, "seed": seed,
                                    "candidate": cand, "optimize": optimize, "budget": budget, "spark_usd": usd,
                                    "held_out": [{"scenario": r["scenario"], "repeat": r["repeat"], "kind": r["kind"],
                                                  "baseline": {"score": b["score"], "parts": b["parts"], "cross": cross_score(b),
                                                               "infra_error": b["infra_error"]},
                                                  "candidate": {"score": r["score"], "parts": r["parts"], "cross": cross_score(r),
                                                                "infra_error": r["infra_error"]}}
                                                 for b, r in pairs]}, indent=1, ensure_ascii=False), encoding="utf-8")
    if out_candidate and full_prompt:
        out_candidate.write_text(f"<!-- H10 candidate {cand_hash}; NOT the live prompt. Gate: "
                                 f"{'passed' if verdict.get('promote') else 'not passed'}. -->\n" + full_prompt, encoding="utf-8")
