"""Scenarios (persona + hidden belief + question) and the tutor policy split into its named sections."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

HERE = Path(__file__).resolve().parent
SCENARIOS_PATH = HERE / "scenarios.json"
SEED_PROMPT = HERE.parent / "prompts" / "tutor-v1.md"
EVOLVED = ("pedagogy_policy", "check_writer", "feedback_policy")  # GEPA components; `moves`, `personalization` stay
MAX_GROWTH = 1.5  # a candidate section may be at most this many times its seed length
SPLITS = ("train", "val", "test")


class Scenario(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    id: str = Field(pattern=r"^[a-z]+\.[a-z0-9-]+$")
    persona: Literal["priya", "tomas", "amara"]
    kind: Literal["known", "hidden"]
    split: Literal["train", "val", "test"]
    concept: str
    belief: str = Field(min_length=10)
    background: str
    question: str = Field(min_length=10)
    markers: tuple[str, ...] = Field(min_length=1)


def load(path: Path = SCENARIOS_PATH) -> list[Scenario]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out = [Scenario.model_validate(s) for s in raw["scenarios"]]
    ids = [s.id for s in out]
    if len(set(ids)) != len(ids):
        raise ValueError("scenario ids must be unique")
    if any(m != m.lower() for s in out for m in s.markers):
        raise ValueError("markers are lowercase")
    return out


def split(scenarios: list[Scenario], name: str) -> list[Scenario]:
    if name not in SPLITS:
        raise ValueError(f"unknown split {name}")
    return [s for s in scenarios if s.split == name]


# ---------------------------------------------------------------------------------------------
# Policy sections

_HEADING = re.compile(r"^## (\w+)[ \t]*$", re.M)


def sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """(preamble, [(name, body)]) where body runs from after the heading line to the next heading."""
    marks = list(_HEADING.finditer(text))
    preamble = text[:marks[0].start()] if marks else text
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out.append((m.group(1), text[m.end():end]))
    return preamble, out


def seed_candidate(text: str | None = None) -> dict[str, str]:
    text = SEED_PROMPT.read_text(encoding="utf-8") if text is None else text
    found = dict(sections(text)[1])
    missing = [name for name in EVOLVED if name not in found]
    if missing:
        raise ValueError(f"seed prompt lacks sections {missing}")
    return {name: found[name].strip("\n") for name in EVOLVED}


def assemble(candidate: dict[str, str], seed_text: str | None = None) -> str:
    """The seed prompt with only the evolved section bodies replaced; every other byte is kept."""
    seed_text = SEED_PROMPT.read_text(encoding="utf-8") if seed_text is None else seed_text
    preamble, parts = sections(seed_text)
    out = [preamble]
    for name, body in parts:
        if name in candidate and name in EVOLVED:
            new = candidate[name].strip("\n")
            if _HEADING.search(new):
                raise ValueError(f"{name} must not contain a section heading")
            # Keep the seed's surrounding blank lines so the frozen sections are byte-identical.
            lead = body[:len(body) - len(body.lstrip("\n"))]
            trail = body[len(body.rstrip("\n")):]
            body = lead + new + trail
        out.append(f"## {name}" + body)
    return "".join(out)


def oversized(candidate: dict[str, str], seed: dict[str, str]) -> list[str]:
    return [f"{name} is {len(candidate[name])} chars (cap {int(len(seed[name]) * MAX_GROWTH)})"
            for name in EVOLVED if len(candidate[name]) > len(seed[name]) * MAX_GROWTH]


def candidate_hash(candidate: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps({k: candidate[k] for k in EVOLVED}, sort_keys=True).encode()).hexdigest()[:12]
