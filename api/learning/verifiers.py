"""Bounded numerical checks. Never execute or eval a learner's expression."""
import math
import re
from typing import Callable

from .contracts import VerifierSpec

NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")


def weighted_sum(parameters: dict) -> float:
    values, weights = parameters["values"], parameters["weights"]
    if not values or len(values) != len(weights) or len(values) > 256:
        raise ValueError("weighted sum requires equally sized nonempty vectors")
    return math.fsum(a * b for a, b in zip(values, weights))


def stereo_depth(parameters: dict) -> float:
    f, baseline, disparity = (parameters[key] for key in ("focal_px", "baseline_m", "disparity_px"))
    if min(f, baseline, disparity) <= 0:
        raise ValueError("this rectified stereo task requires positive parameters")
    return f * baseline / disparity


def eigenvalue(parameters: dict) -> float:
    a, v = parameters["matrix"], parameters["vector"]
    if len(a) != 4 or len(v) != 2 or not any(v):
        raise ValueError("expected a 2x2 matrix and a nonzero vector")
    av = [a[0] * v[0] + a[1] * v[1], a[2] * v[0] + a[3] * v[1]]
    index = max(range(2), key=lambda i: abs(v[i]))
    result = av[index] / v[index]
    if any(not math.isclose(av[i], result * v[i], abs_tol=1e-9, rel_tol=1e-9) for i in range(2)):
        raise ValueError("the supplied vector is not an eigenvector")
    return result


VERIFIERS: dict[str, Callable[[dict], float]] = {
    "weighted_sum": weighted_sum, "stereo_depth": stereo_depth, "eigenvalue": eigenvalue,
}


def verify_number(spec: VerifierSpec, text: str) -> bool | None:
    """None means not verifiable, never a wrong answer inferred from prose."""
    cleaned = text.strip()
    if len(cleaned) > 100 or not NUMBER.fullmatch(cleaned):
        return None
    value = float(cleaned)
    expected = VERIFIERS[spec.kind](spec.parameters)
    if not math.isfinite(value) or not math.isfinite(expected):
        return None
    return math.isclose(value, expected, rel_tol=1e-6, abs_tol=1e-9)
