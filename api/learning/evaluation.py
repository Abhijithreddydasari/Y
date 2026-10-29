"""Provider-independent scoring boundary for a later offline GEPA experiment.

Cases need human review before these scores can support a promotion claim.
The caller may wrap evaluate() in GEPA's evaluator; no optimization runs in a lesson.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Literal

from .contracts import Contract, Dimension, Label, Observation, SourceRef, canonical, digest

BASELINE_POLICY = "capture-shadow-v1"


class EvaluationCase(Contract):
    case_id: str
    pack_id: str
    task_family: str
    split: Literal["engineering", "tune", "validation", "test"]
    reviewed: bool = False
    expected_label: Label
    expected_status: Literal["accepted", "abstained", "pending_review"]
    dimension: Dimension
    source: SourceRef


def evaluate(cases: list[EvaluationCase], predictions: dict[str, Observation]) -> dict:
    if not cases or len({case.case_id for case in cases}) != len(cases):
        raise ValueError("evaluation requires nonempty, uniquely identified cases")
    if set(predictions) != {case.case_id for case in cases}:
        raise ValueError("predictions must cover exactly the evaluation cases")
    if len({case.split for case in cases}) != 1:
        raise ValueError("evaluate tuning, validation, and test splits separately")
    groups = defaultdict(lambda: {"count": 0, "correct": 0, "accepted": 0, "unsafe_acceptances": 0,
                                  "provenance_violations": 0})
    failures = []
    for case in cases:
        observation = predictions[case.case_id]
        group = groups[case.pack_id]
        provenance = observation.source == case.source
        correct = (observation.dimension == case.dimension and observation.label == case.expected_label
                   and observation.status == case.expected_status and provenance)
        accepted = observation.status == "accepted"
        unsafe = accepted and not correct
        group["count"] += 1
        group["correct"] += int(correct)
        group["accepted"] += int(accepted)
        group["unsafe_acceptances"] += int(unsafe)
        group["provenance_violations"] += int(not provenance)
        if not correct:
            failures.append({"case_id": case.case_id, "dimension": case.dimension,
                             "expected": [case.expected_label, case.expected_status],
                             "actual": [observation.label, observation.status], "source_matches": provenance})
    return {
        "score": sum(group["correct"] for group in groups.values()) / len(cases),
        "reviewed": all(case.reviewed for case in cases),
        "baseline_policy": BASELINE_POLICY,
        "per_pack": dict(groups), "failures": failures,
        "case_ids": sorted(predictions),
        "split": cases[0].split,
        "suite_hash": digest(canonical({"cases": [case.model_dump(mode="json") for case in sorted(cases, key=lambda case: case.case_id)]})),
    }


def promotion_allowed(baseline: dict, candidate: dict) -> bool:
    """A necessary offline gate, not an automatic deployment decision."""
    if not baseline["reviewed"] or not candidate["reviewed"] or baseline["case_ids"] != candidate["case_ids"]:
        return False
    if baseline["split"] != "test" or candidate["split"] != "test" or baseline["suite_hash"] != candidate["suite_hash"]:
        return False
    if candidate["score"] <= baseline["score"] or candidate["per_pack"].keys() != baseline["per_pack"].keys():
        return False
    return all(
        stats["provenance_violations"] == 0 and stats["unsafe_acceptances"] == 0
        and stats["count"] == baseline["per_pack"][pack]["count"]
        and stats["correct"] >= baseline["per_pack"][pack]["correct"]
        for pack, stats in candidate["per_pack"].items()
    )
