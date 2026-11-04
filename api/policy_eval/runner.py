"""Runs rollouts for a candidate with a resumable cache, and adapts that to GEPA."""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path

from .budget import Budget, BudgetExceeded
from .clients import Clients
from .rollout import Briefs, board_lines, rollout
from .scenarios import EVOLVED, MAX_GROWTH, Scenario, assemble, candidate_hash, load, oversized, seed_candidate

log = logging.getLogger("y.policy_eval")


class Runner:
    """Rollouts keyed by (candidate hash, scenario, repeat) in `rollouts.jsonl`; a rerun never pays twice.

    `make_clients` is injectable so tests run the whole path on a fake tutor and fake student/judge.
    """

    def __init__(self, run_dir: Path, cap: int, make_clients=None, briefs: Briefs | None = None):
        self.run_dir = run_dir
        run_dir.mkdir(parents=True, exist_ok=True)
        self.budget = Budget(cap, run_dir / "calls.jsonl")
        self.cache_path = run_dir / "rollouts.jsonl"
        self.cache: dict[str, dict] = {}
        if self.cache_path.exists():
            for line in self.cache_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    record = json.loads(line)
                    self.cache[record["key"]] = record
        self.make_clients = make_clients or (lambda budget: Clients(budget))
        self.briefs = briefs or Briefs(run_dir / "personas")
        self.lock = threading.Lock()
        self.candidates: dict[str, dict[str, str]] = {}

    def _save(self, record: dict) -> None:
        with self.lock:
            self.cache[record["key"]] = record
            with self.cache_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def evaluate(self, candidate: dict[str, str], scenarios: list[Scenario], repeat: int = 0,
                 cross: bool = False) -> list[dict]:
        digest = candidate_hash(candidate)
        self.candidates[digest] = {k: candidate[k] for k in EVOLVED}
        (self.run_dir / "candidates").mkdir(exist_ok=True)
        (self.run_dir / "candidates" / f"{digest}.json").write_text(json.dumps(self.candidates[digest], indent=1),
                                                                     encoding="utf-8")
        prompt = assemble(candidate)
        keys = [f"{digest}|{s.id}|{repeat}" for s in scenarios]
        todo = [(k, s) for k, s in zip(keys, scenarios)
                if k not in self.cache or self.cache[k].get("infra_error") or (cross and self.cache[k].get("cross") is None)]
        briefs = {s.id: self.briefs.brief(s) for _, s in todo}
        if todo:
            asyncio.run(self._run(todo, prompt, briefs, digest, repeat, cross))
        return [self.cache[k] for k in keys]

    async def _run(self, todo, prompt, briefs, digest, repeat, cross) -> None:
        clients = self.make_clients(self.budget)

        async def one(key, scenario):
            record = await rollout(clients, scenario, prompt, briefs[scenario.id], cross=cross)
            self._save({"key": key, "candidate": digest, "repeat": repeat, **record})
            log.info("rollout %s %s score %.3f%s", digest, scenario.id, record["score"],
                     f" ({record['infra_error']})" if record["infra_error"] else "")

        try:
            results = await asyncio.gather(*(one(k, s) for k, s in todo), return_exceptions=True)
        finally:
            await clients.aclose()
        for result in results:
            if isinstance(result, BaseException):
                raise result

    def reflect(self, prompt: str) -> str:
        async def go():
            clients = self.make_clients(self.budget)
            try:
                return await clients.reflect(prompt)
            finally:
                await clients.aclose()
        text = asyncio.run(go())
        with (self.run_dir / "reflections.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"prompt": prompt, "response": text}, ensure_ascii=False) + "\n")
        return text


REFLECTION_TEMPLATE = """You are improving one section of the system prompt of Y, a whiteboard tutor. The tutor is
Muse Spark; it writes each turn as JSON board moves. This section is one of: pedagogy_policy (how a turn teaches),
check_writer (how checks and their options are written) or feedback_policy (how the tutor responds to an answer).
Other sections, not shown, fix the move schema; never rename moves or fields or add new ones.

The current text of the section:
```
<curr_param>
```

Below are rollouts with this prompt. In each, a simulated student holds a hidden misconception the tutor was not
told; the student answers the tutor's checks from it unless the teaching explicitly showed why it is wrong. Each has
the tutor's board text, the student's answers, a score breakdown (0 to 1; higher is better) and a judge's critique:
<side_info>

Write an improved version of the section. Make it general: it must help on other topics and misconceptions, so do
not mention the specific topics, beliefs or numbers above. Keep it a short bullet list in the same style. It must be
at most {limit} characters (the current text is {length}); longer text is rejected unread. No lines may start with
"#". Return only the new section text inside one ``` block."""


def reflection_templates(seed: dict[str, str]) -> dict[str, str]:
    """One template per section, with that section's hard length cap spelled out."""
    return {name: REFLECTION_TEMPLATE.replace("{limit}", str(int(len(seed[name]) * MAX_GROWTH)))
            .replace("{length}", str(len(seed[name]))) for name in EVOLVED}


class PolicyAdapter:
    """GEPA adapter: components are the three evolved sections; a rollout is one metric call."""

    propose_new_texts = None

    def __init__(self, runner: Runner, seed: dict[str, str] | None = None):
        self.runner, self.seed = runner, seed or seed_candidate()

    def _rejected(self, batch, why: str, capture: bool):
        from gepa import EvaluationBatch
        outputs = [{"scenario": s.id, "rejected": why} for s in batch]
        return EvaluationBatch(outputs=outputs, scores=[0.0] * len(batch), trajectories=outputs if capture else None)

    def evaluate(self, batch, candidate, capture_traces: bool = False):
        from gepa import EvaluationBatch
        too_long = oversized(candidate, self.seed)
        if too_long:
            return self._rejected(batch, "; ".join(too_long), capture_traces)
        try:
            assemble(candidate)
        except ValueError as exc:
            return self._rejected(batch, str(exc), capture_traces)
        records = self.runner.evaluate(candidate, batch)
        return EvaluationBatch(outputs=records, scores=[r["score"] for r in records],
                               trajectories=records if capture_traces else None)

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        rows = []
        for record in eval_batch.trajectories or []:
            if "rejected" in record:
                rows.append({"Inputs": {"scenario": record["scenario"]}, "Generated Outputs": "(not run)",
                             "Feedback": f"Rejected before running: {record['rejected']}"})
                continue
            turns = []
            for i, turn in enumerate(record["turns"]):
                answer = record["answers"][i] if i < len(record["answers"]) else None
                turns.append({"tutor_board": "\n".join(_board(turn["moves"])) or "(nothing drawn)",
                              "tutor_question": _question_text(turn["moves"]),
                              "dropped_moves": "; ".join(turn["dropped"][:3]) or "none",
                              "student_answer": f"{answer['answer']} ({answer['result']})" if answer else "(no question asked)"})
            parts = record["parts"] or {}
            feedback = (f"Score {record['score']:.2f}. Parts: " + ", ".join(f"{k} {v:.2f}" for k, v in parts.items() if v is not None)
                        + f". Judge: {(record['rubric'] or {}).get('critique') or record['judge_error'] or record['infra_error']}")
            rows.append({"Inputs": {"student_question": record["turns"][0]["user"].rsplit("THIS TURN", 1)[-1][:600],
                                    "hidden_misconception": _belief(record)},
                         "Generated Outputs": turns, "Feedback": feedback})
        return {name: rows for name in components_to_update}


_board = board_lines


def _question_text(moves) -> str:
    q = next((m for m in moves if m["type"] in ("check", "predict")), None)
    if q is None:
        return "(none)"
    key = q.get("key", q.get("answer"))
    return f"{q['q']} options {q['options']} key {key}"


_BELIEFS: dict[str, str] = {}


def _belief(record) -> str:
    if not _BELIEFS:
        _BELIEFS.update({s.id: s.belief for s in load()})
    return _BELIEFS.get(record["scenario"], "")
