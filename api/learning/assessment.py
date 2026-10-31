"""Capture policy: provenance first, explicit uncertainty, decision models in shadow mode."""
from __future__ import annotations

import asyncio
import time
from uuid import uuid4

from .contracts import Assessment, CapturedAttempt, Observation, digest, now_iso
from .decisions import DecisionProvider, ProviderFailure
from .verifiers import verify_number


def provenance_valid(capture: CapturedAttempt) -> bool:
    return (
        capture.source.content_hash == digest(capture.attempt.text)
        and capture.source.start == 0
        and capture.source.end == len(capture.attempt.text)
        and capture.task.task_id == capture.attempt.task_id
    )


async def assess_capture(capture: CapturedAttempt, provider: DecisionProvider) -> Assessment:
    started = time.perf_counter()
    observations = []
    raw, error, usage = None, None, {}

    def abstain(reason: str) -> None:
        observations.extend(Observation(
            dimension=r.dimension, label="not_observable", status="abstained",
            reasons=(reason,), provider="none", source=capture.source,
        ) for r in capture.task.rubrics)

    if not provenance_valid(capture):
        abstain("source_integrity_failed")
    elif not capture.attempt.text.strip():
        abstain("empty_answer")
    elif capture.attempt.assistance.solution_revealed:
        abstain("solution_already_revealed")
    elif capture.task.verifier:
        checked = verify_number(capture.task.verifier, capture.attempt.text)
        for rubric in capture.task.rubrics:
            can_check = rubric.dimension == "mathematical" and checked is not None
            observations.append(Observation(
                dimension=rubric.dimension,
                label=("supported" if checked else "contradicted") if can_check else "not_observable",
                status="accepted" if can_check else "abstained",
                reasons=(("numeric_result_only",) if can_check else ("requires_numeric_answer",))
                + (() if capture.attempt.assistance.independent else ("assisted_attempt",)),
                provider="deterministic", model_version="numeric-v1", source=capture.source,
            ))
    else:
        try:
            # Bound total wall time as well as each HTTP phase, including slow streams.
            async with asyncio.timeout(10):
                result, raw = await provider.assess(capture)
            usage = result.usage.model_dump()
            for dimension, answer in result.answers.items():
                reasons = []
                if dimension == "delayed_retrieval":
                    reasons.append("verified_prior_exposure_required")
                if answer.choice in {"ambiguous", "not_observable"}:
                    reasons.append("insufficient_evidence")
                # Provisional engineering thresholds, not calibrated accuracy claims.
                if answer.confidence < 0.65 or answer.probabilities[answer.choice] < 0.8:
                    reasons.append("uncertain_distribution")
                status = "abstained" if reasons else "pending_review"
                if not reasons:
                    reasons.append("decision_shadow_mode")
                if not capture.attempt.assistance.independent:
                    reasons.append("assisted_attempt")
                observations.append(Observation(
                    dimension=dimension, label=answer.choice, status=status,
                    reasons=tuple(reasons), provider=provider.provider_name, model_version=result.model,
                    model_is_alias=result.model.endswith("-latest"),
                    probabilities=answer.probabilities, provider_confidence=answer.confidence,
                    source=capture.source,
                ))
        except (ProviderFailure, TimeoutError) as exc:
            error = exc.code if isinstance(exc, ProviderFailure) else "provider_timeout"
            raw = exc.raw if isinstance(exc, ProviderFailure) else None
            abstain(error)

    return Assessment(
        assessment_id=uuid4(), attempt_id=capture.attempt.attempt_id,
        observations=tuple(observations), raw_result=raw, provider_error=error,
        latency_ms=(time.perf_counter() - started) * 1000, usage=usage, created_at=now_iso(),
    )
