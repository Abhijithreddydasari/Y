import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest

from learning.assessment import assess_capture
from learning.contracts import Assistance, AttemptInput, CapturedAttempt, Observation, SourceRef, digest, now_iso
from learning.evaluation import EvaluationCase, evaluate, promotion_allowed
from learning.jev import JevClient
from learning.packs import TASKS


def test_seed_fixtures_cover_two_packs_without_fabricated_jev_outputs():
    fixtures = json.loads((Path(__file__).parent / "fixtures" / "learning_seed_cases.json").read_text())
    cases, predictions = [], {}
    for item in fixtures["cases"]:
        task = TASKS[item["task_id"]]
        source = SourceRef(event_id=uuid4(), content_hash=digest(item["text"]), start=0, end=len(item["text"]))
        capture = CapturedAttempt(owner_id="fixture", session_id=uuid4(), task=task, source=source, captured_at=now_iso(),
            attempt=AttemptInput(attempt_id=uuid4(), task_id=task.task_id, text=item["text"], assistance=Assistance(
                solution_revealed=item.get("solution_revealed", False), self_reported_help=item.get("self_reported_help", False))))
        result = asyncio.run(assess_capture(capture, JevClient("")))
        predictions[item["id"]] = result.observations[0]
        cases.append(EvaluationCase(case_id=item["id"], pack_id=task.pack_id, task_family=task.task_id,
            split="engineering", expected_label=item["label"], expected_status=item["status"],
            dimension="mathematical", source=source))
    report = evaluate(cases, predictions)
    assert report["score"] == 1
    assert len(report["per_pack"]) == 2
    assert report["reviewed"] is False
    assert not promotion_allowed(report, report)


def test_evaluator_rejects_foreign_sources_and_missing_predictions():
    source = SourceRef(event_id=uuid4(), content_hash=digest("correct"), start=0, end=7)
    case = EvaluationCase(case_id="c", pack_id="p", task_family="f", split="test", reviewed=True,
                          expected_label="supported", expected_status="accepted", dimension="mathematical",
                          source=source.model_copy(update={"content_hash": digest("another attempt")}))
    prediction = Observation(dimension="mathematical", label="supported", status="accepted", reasons=(),
                              provider="deterministic", source=source)
    report = evaluate([case], {"c": prediction})
    assert report["score"] == 0
    assert report["per_pack"]["p"]["provenance_violations"] == 1
    assert report["per_pack"]["p"]["unsafe_acceptances"] == 1
    with pytest.raises(ValueError):
        evaluate([case], {})


def test_policy_promotion_requires_review_and_no_per_pack_regression():
    source = SourceRef(event_id=uuid4(), content_hash=digest("4"), start=0, end=1)
    cases = [EvaluationCase(case_id=f"c{i}", pack_id=f"p{i}", task_family=f"f{i}", split="test", reviewed=True,
             expected_label="supported", expected_status="accepted", dimension="mathematical", source=source)
             for i in range(2)]
    good = Observation(dimension="mathematical", label="supported", status="accepted", reasons=(), provider="deterministic", source=source)
    uncertain = good.model_copy(update={"label": "not_observable", "status": "abstained"})
    baseline = evaluate(cases, {"c0": good, "c1": uncertain})
    better = evaluate(cases, {"c0": good, "c1": good})
    assert promotion_allowed(baseline, better)
    assert not promotion_allowed(baseline, evaluate(cases, {"c0": uncertain, "c1": good}))
    assert not promotion_allowed(baseline, {**better, "reviewed": False})
    assert not promotion_allowed(baseline, {**better, "case_ids": ["other"]})
    assert not promotion_allowed(baseline, {**better, "suite_hash": "changed labels"})
    assert not promotion_allowed(baseline, {**better, "split": "tune"})
    with pytest.raises(ValueError, match="splits separately"):
        evaluate([cases[0], cases[1].model_copy(update={"split": "tune"})], {"c0": good, "c1": good})
