"""H10 policy evaluation, all mocked: scenarios, policy sections, scores, gate, call cap, adapter rollout."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from policy_eval import clients as clients_mod
from policy_eval import gate, score
from policy_eval.budget import Budget, BudgetExceeded
from policy_eval.rollout import Briefs
from policy_eval.runner import PolicyAdapter, Runner, reflection_templates
from policy_eval.scenarios import (EVOLVED, SEED_PROMPT, assemble, candidate_hash, load, oversized, sections,
                                   seed_candidate, split)


# ---------------------------------------------------------------------------------------------
# Scenarios and sections

def test_scenarios_load_and_split_stratified():
    scenarios = load()
    assert len(scenarios) == 24
    sizes = {name: len(split(scenarios, name)) for name in ("train", "val", "test")}
    assert sizes == {"train": 9, "val": 6, "test": 9}
    for name in ("train", "val", "test"):
        part = split(scenarios, name)
        assert {s.persona for s in part} == {"priya", "tomas", "amara"}
        assert {s.kind for s in part} == {"known", "hidden"}
    test_ids = {s.id for s in split(scenarios, "test")}
    other = {s.belief for s in scenarios if s.id not in test_ids}
    assert not other & {s.belief for s in split(scenarios, "test")}
    with pytest.raises(ValueError):
        split(scenarios, "holdout")


def test_known_beliefs_are_the_fixture_beliefs():
    fixtures = {}
    for key in ("priya", "tomas", "amara"):
        data = json.loads((SEED_PROMPT.parents[1] / "learning" / "fixtures" / "personas" / f"{key}.json")
                          .read_text(encoding="utf-8"))
        fixtures[key] = {b["concept"] for b in data["beliefs"].values()}
    for s in load():
        assert (s.concept in fixtures[s.persona]) == (s.kind == "known"), s.id


def test_assemble_replaces_only_evolved_sections():
    text = SEED_PROMPT.read_text(encoding="utf-8")
    seed = seed_candidate()
    assert set(seed) == set(EVOLVED)
    assert assemble(seed) == text
    changed = {**seed, "check_writer": "- Write a check whose wrong options are real mistakes."}
    out = assemble(changed)
    before, after = dict(sections(text)[1]), dict(sections(out)[1])
    assert after["moves"] == before["moves"] and after["personalization"] == before["personalization"]
    assert sections(out)[0] == sections(text)[0]
    assert "real mistakes" in after["check_writer"] and after["pedagogy_policy"] == before["pedagogy_policy"]
    assert candidate_hash(changed) != candidate_hash(seed)
    with pytest.raises(ValueError):
        assemble({**seed, "feedback_policy": "## moves\n- sneak"})
    assert oversized({**seed, "pedagogy_policy": seed["pedagogy_policy"] * 2}, seed)
    assert not oversized(seed, seed)


# ---------------------------------------------------------------------------------------------
# Scores

def _check(options, key, q="Which is right?"):
    return {"type": "check", "kind": "mcq", "q": q, "options": options, "key": key, "concept": "a.b", "dim": "understand"}


def _turn(moves, dropped=(), status="waiting"):
    return {"moves": moves, "dropped": list(dropped), "status": status}


TEACH = [{"type": "seg", "id": "s1", "goal": "Why softmax"},
         {"type": "write", "text": "Softmax turns scores into weights that favour the largest score."},
         {"type": "say", "text": "We exponentiate each score and divide by the total, so big scores win."}]


def test_probe_counts_a_distractor_not_the_key():
    markers = ("equal",)
    good = _turn(TEACH + [_check(["The largest wins", "All roughly equal"], "The largest wins")])
    assert score.probe([good], markers, first_wrong=False) == 1.0
    key_only = _turn(TEACH + [_check(["All roughly equal", "The largest wins"], "All roughly equal")])
    assert score.probe([key_only], markers, first_wrong=False) == 0.0
    assert score.probe([key_only], markers, first_wrong=True) == 1.0


def test_addresses_valid_length_resolved_total():
    markers = ("roughly equal",)
    t1 = _turn(TEACH)
    t2 = _turn([{"type": "seg", "id": "s1", "goal": "Not roughly equal"}, *TEACH[1:]])
    assert score.addresses([t1, t2], markers) == 1.0
    assert score.addresses([t2, t1], markers) == 0.5
    assert score.addresses([t1, t1], markers) == 0.0
    assert score.valid([_turn(TEACH, dropped=["move 3: bad"]), _turn([], status="failed")]) == pytest.approx(0.375)
    assert score.length([_turn(TEACH)]) == pytest.approx(score.words(TEACH) / score.LENGTH_BAND[0])
    long = [{"type": "write", "text": "word " * 390}]
    assert score.length([_turn(long)]) == pytest.approx(1 - (390 - 260) / 260)
    assert score.resolved({"result": "correct"}, None) == 1.0
    assert score.resolved({"result": "unverified"}, "no") == 0.0
    assert score.resolved({"result": "unverified"}, None) == 0.5
    assert score.resolved(None, "yes") == 0.0
    full = {k: 1.0 for k in score.WEIGHTS}
    assert score.total(full) == pytest.approx(1.0)
    assert score.total({**full, "judge": None, "valid": 0.0}) == pytest.approx(1 - 0.10 / 0.65)
    assert score.judge_part({k: 5 for k in score.RUBRIC}) == 1.0 and score.judge_part(None) is None


# ---------------------------------------------------------------------------------------------
# Gate

def _rec(scenario, s, repeat=0, valid=1.0, infra=None):
    parts = {k: 0.5 for k in score.WEIGHTS} | {"valid": valid}
    return {"scenario": scenario, "repeat": repeat, "score": s, "parts": parts, "infra_error": infra, "cross": None}


def test_gate_threshold_and_valid_drop():
    base = [_rec("a", 0.5), _rec("b", 0.5)]
    assert not gate.decide(base, [_rec("a", 0.549), _rec("b", 0.549)])["promote"]
    passed = gate.decide(base, [_rec("a", 0.55), _rec("b", 0.55)])
    assert passed["promote"] and passed["gain"] == pytest.approx(0.05)
    dropped = gate.decide(base, [_rec("a", 0.7, valid=0.97), _rec("b", 0.7, valid=0.97)])
    assert not dropped["promote"] and "valid rate" in dropped["reason"]


def test_gate_excludes_infra_pairs_and_reports_interval():
    base = [_rec("a", 0.5), _rec("b", 0.5), _rec("c", 0.5, infra="call_failed:provider_timeout")]
    cand = [_rec("a", 0.6), _rec("b", 0.7), _rec("c", 0.0)]
    verdict = gate.decide(base, cand)
    assert verdict["pairs"] == 2 and verdict["excluded"] == 1
    assert verdict["gain"] == pytest.approx(0.15)
    lo, hi = verdict["interval90"]
    assert 0.1 - 1e-9 <= lo <= hi <= 0.2 + 1e-9 and verdict["interval_excludes_zero"]
    assert not gate.decide([], [])["promote"]


# ---------------------------------------------------------------------------------------------
# Call cap

def test_budget_cap_and_resume(tmp_path):
    log = tmp_path / "calls.jsonl"
    budget = Budget(3, log)
    for _ in range(3):
        budget.reserve("student")
        budget.record("student", "m", "ok", 1.0, {"input_tokens": 10})
    with pytest.raises(BudgetExceeded):
        budget.reserve("judge")
    again = Budget(4, log)
    assert again.used == 3 and again.tokens["student|m"]["input_tokens"] == 30
    again.reserve("judge")
    with pytest.raises(BudgetExceeded):
        again.reserve("judge")


def test_retries_count_against_cap_and_cap_stops_before_sending(monkeypatch):
    monkeypatch.setenv("BASETEN_API_KEY", "test-key")

    async def no_sleep(_):
        return None

    monkeypatch.setattr(clients_mod.asyncio, "sleep", no_sleep)
    sent = []

    def handler(request):
        sent.append(request)
        if len(sent) == 1:
            return httpx.Response(500)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"answer": "x", "still_believes": true}'}}],
                                         "usage": {"prompt_tokens": 5, "completion_tokens": 2}})

    async def go(cap):
        budget = Budget(cap)
        c = clients_mod.Clients(budget, http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        try:
            return await c.open_json("student", "sys", "user", {"type": "object"}), budget
        finally:
            await c.aclose()

    value, budget = asyncio.run(go(5))
    assert value["answer"] == "x" and budget.used == 2 and len(sent) == 2
    assert "test-key" not in json.dumps(budget.summary())
    sent.clear()
    with pytest.raises(BudgetExceeded):
        asyncio.run(go(1))  # first attempt fails with 500; the retry would be call 2
    assert len(sent) == 1


# ---------------------------------------------------------------------------------------------
# Adapter rollout on a fake tutor, student and judge

def _turn_json(markers_option: str) -> str:
    moves = [{"type": "seg", "id": "s1", "goal": "How softmax weighs scores"},
             {"type": "write", "text": "Softmax exponentiates scores, so the largest one gets most of the weight."},
             {"type": "say", "text": "We take e to each score and divide by the sum, so bigger scores win by a lot."},
             {"type": "check", "kind": "mcq", "q": "Scores 2, 1, 0 go through softmax. What happens?",
              "options": ["The largest gets about 0.67", markers_option], "key": "The largest gets about 0.67",
              "concept": "attention.softmax", "dim": "understand"},
             {"type": "turn_end", "reason": "wait"}]
    return json.dumps({"moves": moves})


class FakeTutor:
    model = "fake-tutor"

    def __init__(self, calls):
        self.calls, self.totals, self.timing = calls, {}, {}

    async def stream(self, messages):
        self.calls.append(("tutor", messages[0]["content"]))
        text = _turn_json("All about one third each")
        for i in range(0, len(text), 50):
            yield text[i:i + 50]

    async def complete(self, messages, max_tokens=1500, fmt=None):
        raise AssertionError("no repair expected")


class FakeClients:
    def __init__(self, budget, calls):
        self.budget, self.calls = budget, calls
        self.stream_sem = asyncio.Semaphore(4)

    def tutor(self, system_prompt):
        return FakeTutor(self.calls)

    async def open_json(self, role, system, user, schema, max_tokens=6000):
        self.budget.reserve(role)
        self.calls.append((role, None))
        if role == "student":
            return {"answer": "All about one third each", "still_believes": True}
        return {**{k: 4 for k in score.RUBRIC}, "final_correct": "no", "critique": "Confront the equal-weights idea."}

    async def decide(self, role, data, questions):
        self.budget.reserve(role)
        return [{"choice": "4", "probabilities": [{"value": "4", "probability": 1.0}]} for _ in questions]

    async def reflect(self, prompt):
        self.budget.reserve("reflect")
        return "```\n- new text\n```"

    async def aclose(self):
        return None


def test_adapter_rollout_scores_caches_and_reflects(tmp_path):
    calls = []
    runner = Runner(tmp_path / "run", cap=50, make_clients=lambda budget: FakeClients(budget, calls),
                    briefs=Briefs(tmp_path / "personas"))
    scenario = next(s for s in load() if s.id == "priya.softmax-equalizes")
    adapter = PolicyAdapter(runner)
    batch = adapter.evaluate([scenario], seed_candidate(), capture_traces=True)
    record = batch.outputs[0]
    assert record["infra_error"] is None and len(record["turns"]) == 2
    assert all(t["status"] == "waiting" and not t["dropped"] for t in record["turns"])
    assert record["answers"][0]["result"] == "incorrect" and record["answers"][0]["method"] == "option"
    assert "M1" in record["brief"]  # the persona's real brief, built without a model
    assert record["parts"]["probe"] == 1.0 and record["parts"]["resolved"] == 0.0
    assert record["parts"]["valid"] == 1.0 and record["parts"]["judge"] == pytest.approx(0.75)
    assert 0.0 < batch.scores[0] < 1.0
    roles = [r for r, _ in calls]
    assert roles.count("tutor") == 2 and roles.count("student") == 2 and roles.count("judge") == 1
    assert runner.budget.by_role["tutor"] == 2  # streams are reserved too
    data = adapter.make_reflective_dataset(seed_candidate(), batch, ["check_writer"])
    row = data["check_writer"][0]
    assert "Confront" in row["Feedback"] and row["Inputs"]["hidden_misconception"]
    calls.clear()
    again = adapter.evaluate([scenario], seed_candidate())
    assert not calls and again.scores == batch.scores  # cached: no new calls
    reloaded = Runner(tmp_path / "run", cap=50, make_clients=lambda b: FakeClients(b, calls), briefs=runner.briefs)
    assert reloaded.evaluate(seed_candidate(), [scenario])[0]["score"] == batch.scores[0] and not calls
    rejected = adapter.evaluate([scenario], {**seed_candidate(), "pedagogy_policy": "x" * 5000}, capture_traces=True)
    assert rejected.scores == [0.0] and not calls


def test_candidate_prompt_reaches_the_tutor(tmp_path):
    calls = []
    runner = Runner(tmp_path / "run", cap=50, make_clients=lambda budget: FakeClients(budget, calls),
                    briefs=Briefs(tmp_path / "personas"))
    scenario = next(s for s in load() if s.id == "tomas.lr-bigger-faster")
    candidate = {**seed_candidate(), "pedagogy_policy": "- Teach briefly."}
    runner.evaluate(candidate, [scenario])
    systems = [s for r, s in calls if r == "tutor"]
    assert systems and all(s == assemble(candidate) and "- Teach briefly." in s for s in systems)


def test_reflection_templates_state_each_cap():
    seed = seed_candidate()
    templates = reflection_templates(seed)
    assert set(templates) == set(EVOLVED)
    for name, text in templates.items():
        assert f"at most {int(len(seed[name]) * 1.5)} characters" in text
        assert "<curr_param>" in text and "<side_info>" in text
