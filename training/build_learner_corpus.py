"""Build licensed synthetic learner trajectories with known hidden state.

GSM8K (MIT) and OpenBookQA (Apache-2.0) provide item text, not personal
student records. GPT-5.6-terra can label open-vocabulary concepts and plausible
misconceptions; a deterministic simulator then supplies ground-truth mastery.

Examples:
  python training/build_learner_corpus.py --learners 2000 --labeler openai
  python training/build_learner_corpus.py --learners 8 --items 12 --offline-smoke
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "training" / "data" / "learner_trajectories.jsonl"


@dataclass
class Item:
    item_id: str
    domain: str
    prompt: str
    answer: str
    concepts: list[str]
    prerequisites: list[str]
    misconceptions: list[str]
    difficulty: float
    source: str


SMOKE_ITEMS = [
    ("math", "A box has 3 red and 5 blue pens. How many pens?", "8"),
    ("math", "What is 1/2 + 1/3?", "5/6"),
    ("math", "A rectangle is 4 by 7. Find its area.", "28"),
    ("science", "What force pulls objects toward Earth?", "gravity"),
    ("science", "Which particle has a negative charge?", "electron"),
    ("science", "Why does a metal spoon feel colder than wood?", "thermal conductivity"),
]


def clean_concept(value: str) -> str:
    value = re.sub(r"[^a-z0-9+.# /_-]+", "", value.lower()).strip()
    return re.sub(r"\s+", "-", value)[:64]


def heuristic_labels(domain: str, prompt: str) -> dict:
    lower = prompt.lower()
    mapping = [
        ("fraction", "fraction addition"), ("area", "rectangle area"),
        ("force", "forces"), ("charge", "electric charge"),
        ("cold", "thermal conductivity"), ("how many", "whole-number addition"),
    ]
    concept = next((name for token, name in mapping if token in lower), f"{domain} reasoning")
    return {
        "concepts": [concept],
        "prerequisites": ["basic arithmetic" if domain == "math" else "scientific observation"],
        "misconceptions": ["uses a familiar operation without checking the quantities", "states an answer without linking it to the evidence"],
        "difficulty": 0.35,
    }


def openai_labels(domain: str, prompt: str, answer: str) -> dict:
    from openai import OpenAI

    client = OpenAI()
    response = client.responses.create(
        model=os.environ.get("OPENAI_EVIDENCE_MODEL", "gpt-5.6-terra"),
        instructions=(
            "Label one education item. Output JSON only with concepts (1-4 open-vocabulary strings), "
            "prerequisites (0-4 strings), misconceptions (exactly 2 plausible wrong-response descriptions), "
            "and difficulty (0 to 1). Do not add student traits."
        ),
        input=f"Domain: {domain}\nQuestion: {prompt}\nAnswer: {answer}",
        reasoning={"effort": "low"},
        store=False,
    )
    text = response.output_text.strip().removeprefix("```json").removesuffix("```").strip()
    return json.loads(text)


def load_source_items(limit: int, offline: bool) -> list[tuple[str, str, str, str, str]]:
    if offline:
        return [(f"smoke-{i}", domain, prompt, answer, "smoke") for i, (domain, prompt, answer) in enumerate(SMOKE_ITEMS)]
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError as exc:
        raise SystemExit("Install `datasets` or pass --offline-smoke") from exc
    rows: list[tuple[str, str, str, str, str]] = []
    math = load_dataset("openai/gsm8k", "main", split="train")
    for i, row in enumerate(math):
        answer = str(row["answer"]).split("####")[-1].strip()
        rows.append((f"gsm8k-{i}", "math", str(row["question"]), answer, "GSM8K"))
        if len(rows) >= limit // 2:
            break
    science = load_dataset("allenai/openbookqa", "main", split="train")
    for i, row in enumerate(science):
        choices = row["choices"]
        labels = list(choices["label"])
        texts = list(choices["text"])
        key = str(row["answerKey"])
        answer = texts[labels.index(key)] if key in labels else key
        prompt = str(row["question_stem"]) + " Choices: " + "; ".join(f"{a}) {b}" for a, b in zip(labels, texts))
        rows.append((f"openbookqa-{i}", "science", prompt, answer, "OpenBookQA"))
        if len(rows) >= limit:
            break
    return rows


def label_items(raw_items: Iterable[tuple[str, str, str, str, str]], labeler: str) -> list[Item]:
    items: list[Item] = []
    for item_id, domain, prompt, answer, source in raw_items:
        try:
            labels = openai_labels(domain, prompt, answer) if labeler == "openai" else heuristic_labels(domain, prompt)
        except Exception as exc:
            print(f"warning: GPT label failed for {item_id}: {exc}; using heuristic")
            labels = heuristic_labels(domain, prompt)
        concepts = [clean_concept(str(c)) for c in labels.get("concepts", []) if clean_concept(str(c))]
        items.append(Item(
            item_id=item_id, domain=domain, prompt=prompt, answer=answer,
            concepts=concepts or [f"{domain}-reasoning"],
            prerequisites=[clean_concept(str(c)) for c in labels.get("prerequisites", [])],
            misconceptions=[str(c)[:240] for c in labels.get("misconceptions", [])][:2],
            difficulty=max(0.05, min(0.95, float(labels.get("difficulty", 0.5)))),
            source=source,
        ))
    return items


def sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-value))


def split_for(learner_id: int, domain: str, cluster: int) -> str:
    # Science is the held-out domain; cluster 4 tests unseen concept groups.
    if domain == "science":
        return "test_domain"
    if cluster == 4:
        return "test_concept"
    bucket = int(hashlib.sha256(f"learner-{learner_id}".encode()).hexdigest()[:8], 16) % 10
    return "train" if bucket < 8 else "validation"


def simulate(items: list[Item], learners: int, turns: int, seed: int) -> Iterable[dict]:
    rng = random.Random(seed)
    concept_names = sorted({concept for item in items for concept in item.concepts})
    # Stable balanced cluster ids guarantee a complete held-out cluster even
    # in the tiny offline smoke corpus.
    concept_cluster = {name: index % 4 for index, name in enumerate(concept_names)}
    math_concepts = sorted({concept for item in items if item.domain == "math" for concept in item.concepts})
    if math_concepts:
        concept_cluster[math_concepts[-1]] = 4
    for learner in range(learners):
        mastery = {name: rng.betavariate(2, 2) for name in concept_names}
        slip, guess = rng.uniform(0.03, 0.18), rng.uniform(0.05, 0.22)
        learning, forgetting = rng.uniform(0.03, 0.15), rng.uniform(0.001, 0.025)
        history: list[dict] = []
        for turn in range(turns):
            item = rng.choice(items)
            concept = rng.choice(item.concepts)
            hidden_before = mastery[concept]
            probability = guess + (1 - slip - guess) * sigmoid(5 * (hidden_before - item.difficulty))
            correct = rng.random() < probability
            partial = not correct and rng.random() < 0.22
            outcome = {"correct": 0.9 if correct else 0.05, "partial": 0.08 if correct else (0.85 if partial else 0.1), "incorrect": 0.02 if correct else (0.1 if partial else 0.85)}
            misconception = "" if correct else rng.choice(item.misconceptions or ["unknown misconception"])
            independence = rng.uniform(0.65, 1.0)
            strength = rng.uniform(0.75, 1.0)
            mastery[concept] = min(0.995, hidden_before + (1 - hidden_before) * learning) if correct else hidden_before
            for other in mastery:
                if other != concept:
                    mastery[other] = max(0.005, mastery[other] * (1 - forgetting))
            event = {
                "learner_id": f"synthetic-{learner:06d}", "turn": turn,
                "item": asdict(item), "concept": concept,
                "concept_cluster": concept_cluster[concept],
                "split": split_for(learner, item.domain, concept_cluster[concept]),
                "outcome": outcome, "independence": independence,
                "evidence_strength": strength, "misconception": misconception,
                "hidden_mastery_before": hidden_before,
                "hidden_mastery_after": mastery[concept],
                "response_summary": "correct independent response" if correct else misconception,
                "simulator": {"slip": slip, "guess": guess, "learning": learning, "forgetting": forgetting},
            }
            history.append(event)
        yield {"learner_id": f"synthetic-{learner:06d}", "events": history}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--items", type=int, default=400)
    parser.add_argument("--learners", type=int, default=2000)
    parser.add_argument("--turns", type=int, default=32)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--labeler", choices=["openai", "heuristic"], default="openai")
    parser.add_argument("--offline-smoke", action="store_true")
    args = parser.parse_args()
    raw = load_source_items(args.items, args.offline_smoke)
    items = label_items(raw, "heuristic" if args.offline_smoke else args.labeler)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "y-synthetic-trajectories-v1", "seed": args.seed,
        "learners": args.learners, "turns": args.turns,
        "sources": {"GSM8K": "MIT", "OpenBookQA": "Apache-2.0"},
        "items_sha256": hashlib.sha256(json.dumps([asdict(item) for item in items], sort_keys=True).encode()).hexdigest(),
    }
    with args.output.open("w", encoding="utf-8") as handle:
        for trajectory in simulate(items, args.learners, args.turns, args.seed):
            handle.write(json.dumps(trajectory, ensure_ascii=False) + "\n")
    manifest_path = args.output.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "manifest": str(manifest_path), **manifest}, indent=2))


if __name__ == "__main__":
    main()
