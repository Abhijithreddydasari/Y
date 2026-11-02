"""H4 evidence capture: verifiers, key audit, dedupe, provenance and background labeling (all mocked)."""
import asyncio
import json
import time
from uuid import uuid4

import httpx
import pytest

from learning import observations
from learning.board_contracts import Edit, EditBatch, Element
from learning.board_storage import BoardStore
from learning.contracts import digest
from learning.decisions import EVIDENCE_QUESTIONS, EvidenceLabeler, EvidenceResponse, ProviderFailure
from learning.learner_contracts import Observation
from learning.observations import ExprError, audit_key, compile_expr, number_of, symbolic_equal, verify
from learning.tutor_turn import TurnInput, grade, this_turn
from test_tutor_turn import CHECK, SEG, WAIT, WRITE, FakeTutor, ask, doc, env, events  # noqa: F401

DONE = {"type": "turn_end", "reason": "done"}
FREE = {"type": "check", "kind": "free", "q": "What is \\sqrt{64}?", "key": "6", "concept": "roots", "dim": "apply", "options": []}
PREDICT = {"type": "predict", "q": "Will the weights get sharper?", "options": ["yes", "no"], "answer": "yes"}


def question(kind="free", q="?", key="x", options=()):
    return {"qid": "t.1", "kind": kind, "q": q, "key": key, "options": list(options), "concept": "c", "dim": "apply"}


# --- verifiers ---------------------------------------------------------------------------------

@pytest.mark.parametrize("answer,key,result,method", [
    ("25/3", "8.333", "correct", "numeric"),
    ("8.33", "25/3", "correct", "numeric"),
    ("\\frac{1}{2}", "0.5", "correct", "numeric"),
    ("x = 4", "4", "correct", "numeric"),
    ("about 22.6", "22.63", "correct", "numeric"),
    ("12.5%", "0.125", "correct", "numeric"),
    ("54", "56", "incorrect", "numeric"),
    ("2(x+1)", "2x+2", "correct", "symbolic"),
    ("x^2-1", "(x-1)(x+1)", "correct", "symbolic"),
    ("2x+3", "2x+2", "incorrect", "symbolic"),
    (" Variance ", "variance", "correct", "exact"),
    ("yes", "no", None, None),
    ("the variance grows", "variance", None, None),
])
def test_free_answer_verifiers(answer, key, result, method):
    assert verify(question(key=key), answer) == {"result": result, "method": method}


def test_option_verifier_and_rounded_key_tolerance():
    mcq = question("mcq", key="b", options=["a", "b"])
    assert verify(mcq, "b")["result"] == "correct" and verify(mcq, "a")["result"] == "incorrect"
    assert number_of("22.6") == (22.6, pytest.approx(0.05))
    assert verify(question(key="22.6"), "22.7")["result"] == "incorrect"


@pytest.mark.parametrize("text", ["__import__('os')", "a" * 201, "open(1)", "(" * 50 + "1" + ")" * 50, "1 +", "lambda"])
def test_parser_rejects_everything_outside_its_grammar(text):
    with pytest.raises(ExprError):
        compile_expr(text)


def test_symbolic_needs_maths_on_both_sides():
    assert symbolic_equal("xy", "yx") is None  # no operator or digit: treated as prose
    assert symbolic_equal("x*y", "y*x") is True


@pytest.mark.parametrize("q,key,status,corrected", [
    ("What is \\sqrt{64}?", "6", "wrong", "8"),
    ("What is 7 \\times 8?", "54", "wrong", "56"),
    ("What is 7 \\times 8?", "56", "ok", None),
    ("Compute $\\frac{512}{8}$.", "64", "ok", None),
    ("Solve 3x + 5 = 20", "5", "ok", None),  # has a variable: nothing closed to recompute
    ("With d_k = 64, what is \\sqrt{d_k}?", "6", "ok", None),
    ("Why do we scale?", "variance", "ok", None),
])
def test_key_audit_catches_wrong_numeric_keys(q, key, status, corrected):
    audit = audit_key(question(q=q, key=key))
    assert audit["status"] == status and audit["corrected_key"] == corrected


def test_key_audit_on_options_points_to_the_right_option():
    mcq = question("mcq", q="What is 7 * 8?", key="54", options=["54", "56", "64"])
    assert audit_key(mcq) == {"status": "wrong", "recomputed": "56", "corrected_key": "56"}


def test_grade_uses_the_recomputed_key_and_tells_the_tutor():
    q = {**question(q="What is \\sqrt{64}?", key="6")}
    body = TurnInput(turn_id=uuid4(), kind="answer", question_id="t.1", text="8")
    graded = grade(q, body)
    assert graded["result"] == "correct" and graded["key_status"] == "wrong"
    assert "evaluates to 8" in this_turn(body, q, graded)["key_audit"]
    honest = grade(question(q="What is \\sqrt{64}?", key="8"), body)
    assert "key_audit" not in this_turn(body, question(key="8"), honest)


# --- the answer path ----------------------------------------------------------------------------

class FakeLabeler:
    """Scripted Elephant: picks the given choice per question, or raises; records every request."""

    def __init__(self, picks=None, fail=None, delay=0.0, p=0.9, refuse=()):
        self.picks, self.fail, self.delay, self.p, self.refuse = picks or {}, fail, delay, p, set(refuse)
        self.calls, self.timeout, self.configured, self.model = [], 8.0, True, "decision-models/baseten-elephant-9b-latest"
        self.provider_name, self.images = "baseten", ()

    async def label(self, state, asked, images=()):
        self.calls.append((state, asked))
        self.images = images
        await asyncio.sleep(self.delay)
        if self.fail:
            raise ProviderFailure(self.fail)
        answers = {}
        for name, (_prompt, criteria) in asked.items():
            if name in self.refuse:
                continue
            options = list(criteria)
            choice = self.picks.get(name, options[0])
            rest = (1 - self.p) / (len(options) - 1)
            answers[name] = {"type": "choice", "choice": choice, "confidence": self.p,
                             "probabilities": {o: (self.p if o == choice else rest) for o in options}}
        return EvidenceResponse.model_validate({"model": self.model, "answers": answers,
                                                "usage": {"input_tokens": 300, "output_tokens": 0}}), {}


@pytest.fixture(autouse=True)
def one_loop(env):
    """One event loop for the whole test, as under uvicorn, so background labeling outlives its request."""
    with env[0]:
        yield


def trace(client, sid):
    return client.get(f"/learning/sessions/{sid}/evidence").json()


def settled(client, sid, count=1, seconds=5.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        rows = trace(client, sid)["observations"]
        if len(rows) >= count and all(r["status"] != "pending" for r in rows):
            return rows
        time.sleep(0.02)
    raise AssertionError(f"evidence still pending: {rows}")


def waiting(client, sid, holder, *moves):
    holder["tutor"] = FakeTutor([doc(SEG, *moves, WAIT), doc(WRITE, DONE), doc(WRITE, DONE), doc(WRITE, DONE)])
    _, response = ask(client, sid)
    return events(response)[-1][1]["question"]["qid"]


def answer(client, sid, qid, **body):
    return client.post(f"/learning/sessions/{sid}/tutor/turns",
                       json={"turn_id": str(uuid4()), "kind": "answer", "question_id": qid, **body})


def test_correct_tap_is_deterministic_and_never_asks_about_outcome(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="variance", confidence=70))
    [row] = settled(client, sid)
    observation = Observation.model_validate(row["observation"])
    assert observation.outcome == "correct" and observation.check_id == qid
    assert observation.concept == "attention.scaling" and observation.dimension == "understand"
    assert observation.confidence == 0.7 and observation.format_weight == pytest.approx(2 / 3, abs=1e-3)
    assert row["modality"] == "tap" and row["fields"]["outcome"]["source"] == "deterministic"
    [(state, asked)] = labeler.calls
    assert set(asked) == {"key_valid"}  # a right answer has no miss to classify
    assert state["learner_answer"] == "variance" and state["answer_format"] == "tap"


def test_wrong_tap_gets_a_miss_class_and_an_option_misconception(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"miss_class": "discrimination", "misconception": "attention.scaling/the-mean"})
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    [row] = settled(client, sid)
    observation = row["observation"]
    assert observation["outcome"] == "incorrect" and observation["labeler"] == "baseten"
    assert observation["miss_class"] == "discrimination" and observation["misconception"] == "attention.scaling/the-mean"
    candidates = holder["labeler"].calls[0][1]["misconception"][1]
    assert set(candidates) == {"none", "other", "attention.scaling/the-mean", "attention.scaling/nothing"}


def test_low_probability_labels_are_not_taken(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"miss_class": "careless"}, p=0.4)
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="nothing"))
    [row] = settled(client, sid)
    assert row["observation"]["miss_class"] is None and row["fields"]["miss_class"]["taken"] is False
    # The verifier decided the outcome; the model's soft misconception mass is still kept.
    assert row["observation"]["outcome_p"] is None and row["observation"]["label_confidence"] == 1.0
    assert row["observation"]["misconception_p"] and row["observation"]["labeler"] == "baseten"


def test_unverifiable_free_answer_is_labeled_by_elephant(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"outcome": "partial", "miss_class": "structural"})
    free = {**FREE, "q": "Why scale scores by root d?", "key": "to keep variance near one"}
    qid = waiting(client, sid, holder, free)
    events(answer(client, sid, qid, text="so the softmax is not too peaky", via="spoken"))
    [row] = settled(client, sid)
    assert row["observation"]["outcome"] == "partial" and row["observation"]["miss_class"] == "structural"
    assert row["modality"] == "spoken" and row["observation"]["format_weight"] == 0.9
    # Seven words: reasoning is asked too.
    assert {"outcome", "miss_class", "misconception", "key_valid", "reasoning"} == set(holder["labeler"].calls[0][1])
    assert row["observation"]["outcome_p"]["partial"] == 0.9 and row["observation"]["reasoning_shown"] is not None


def test_uncertain_outcome_keeps_its_distribution(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler(p=0.3)
    qid = waiting(client, sid, holder, {**FREE, "q": "Why?", "key": "because"})
    events(answer(client, sid, qid, text="no idea"))
    [row] = settled(client, sid)
    found = row["observation"]
    assert row["status"] == "labeled" and found["label_confidence"] == 0.3
    assert abs(sum(found["outcome_p"].values()) - 1) < 1e-3 and "reasoning" not in holder["labeler"].calls[0][1]


def test_refused_outcome_leaves_no_observation_but_a_trace(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler(refuse={"outcome"})
    qid = waiting(client, sid, holder, {**FREE, "q": "Why?", "key": "because"})
    events(answer(client, sid, qid, text="no idea"))
    [row] = settled(client, sid)
    assert row["status"] == "failed" and row["error"] == "label_uncertain" and row["observation"] is None


def test_wrong_key_is_flagged_and_the_learner_is_not_marked_wrong(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler()
    qid = waiting(client, sid, holder, FREE)
    got = events(answer(client, sid, qid, text="8"))
    assert got[0][1]["outcome"]["result"] == "correct"
    sent = json.loads(holder["tutor"].calls[1][1]["content"][3]["text"].split("\n", 1)[1])
    assert "evaluates to 8" in sent["key_audit"]
    [row] = settled(client, sid)
    assert row["key_status"] == "wrong" and row["observation"]["key_status"] == "wrong"
    assert row["observation"]["outcome"] == "correct"


def test_elephant_can_only_raise_a_key_to_suspect(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"key_valid": "invalid"})
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="variance"))
    [row] = settled(client, sid)
    assert row["key_status"] == "suspect" and row["observation"]["key_status"] == "suspect"


def test_reveal_is_unanswered_with_assistance_and_no_paid_call(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, reveal=True))
    [row] = settled(client, sid)
    assert row["status"] == "deterministic" and labeler.calls == []
    assert row["observation"]["outcome"] == "unanswered" and row["observation"]["assistance"]["solution_revealed"] is True
    assert row["observation"]["format_weight"] == pytest.approx(1 / 3, abs=1e-3)


def test_predict_borrows_the_session_concept(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="variance"))
    holder["tutor"] = FakeTutor([doc(SEG, PREDICT, WAIT), doc(WRITE, DONE)])
    _, response = ask(client, sid, "And with a lower temperature?")
    pid = events(response)[-1][1]["question"]["qid"]
    events(answer(client, sid, pid, choice="no"))
    rows = settled(client, sid, 2)
    predict = next(r for r in rows if r["qid"] == pid)["observation"]
    assert predict["concept"] == "attention.scaling" and predict["dimension"] == "understand"
    assert predict["outcome"] == "incorrect" and predict["format_weight"] == 0.5


def test_predict_without_any_check_uses_its_goal():
    q = {"qid": "a.1", "kind": "predict", "q": "Sharper?", "key": "yes", "options": ["yes", "no"], "concept": None, "dim": None}
    history = [{"question": q, "moves": [{"type": "seg", "goal": "Temperature sharpens softmax"}]}]
    assert observations.concept_of(q, history) == ("topic:temperature-sharpens-softmax", "understand")


# --- dedupe, provenance and failure -------------------------------------------------------------

def test_duplicate_answers_never_double_count(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    body = {"turn_id": str(uuid4()), "kind": "answer", "question_id": qid, "choice": "the mean"}
    events(client.post(f"/learning/sessions/{sid}/tutor/turns", json=body))
    events(client.post(f"/learning/sessions/{sid}/tutor/turns", json=body))  # replayed turn id: no new capture
    [row] = settled(client, sid)
    assert row["duplicates"] == 0 and len(labeler.calls) == 1
    store = observations.ObservationStore(capture)
    stored = trace(client, sid)["observations"][0]
    q = json.loads(json.dumps({"qid": qid, "kind": "mcq", "q": "q", "options": ["a"], "key": "a", "concept": "c", "dim": "apply"}))
    view, created = store.capture_answer(owner, str(sid), str(uuid4()), q, "a", {"result": "correct", "verified": "correct"},
                                         "tap", [])
    assert created is False and view["observation_id"] == stored["observation_id"]
    assert view["duplicates"] == 1 and view["observation"]["outcome"] == "incorrect"  # the first answer stands


def test_reanswer_after_a_failed_feedback_turn_keeps_one_observation(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler()
    holder["tutor"] = FakeTutor([doc(SEG, CHECK, WAIT), "", doc(WRITE, DONE)], fail=None)
    _, response = ask(client, sid)
    qid = events(response)[-1][1]["question"]["qid"]
    holder["tutor"].fail = "provider_timeout"
    events(answer(client, sid, qid, choice="the mean"))
    assert client.get(f"/learning/sessions/{sid}/tutor").json()["open"]["qid"] == qid  # still open after the failure
    holder["tutor"].fail = None
    events(answer(client, sid, qid, choice="variance"))
    [row] = settled(client, sid)
    assert row["duplicates"] == 1 and row["observation"]["outcome"] == "incorrect" and len(labeler.calls) == 1


def test_sources_are_only_the_learners_input(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    turn_id = str(uuid4())
    events(client.post(f"/learning/sessions/{sid}/tutor/turns", json={
        "turn_id": turn_id, "kind": "answer", "question_id": qid, "choice": "the mean"}))
    [row] = settled(client, sid)
    [source] = row["observation"]["sources"]
    assert source == {"event_id": turn_id, "modality": "tap", "content_hash": digest("the mean"), "element_ids": [], "author": "learner"}
    assert "variance" not in json.dumps({k: v for k, v in row.items() if k != "fields"})  # the key stays server-side


def test_question_turns_never_create_evidence(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler()
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, DONE)])
    events(ask(client, sid, "The answer is 42, right?")[1])
    assert trace(client, sid) == {"observations": [], "profile_updated": False, "profile_revision": None}
    assert labeler.calls == []


def _scene(capture, owner, sid, actor, element_id):
    boards = BoardStore(capture)
    revision = boards.load(owner, sid)["revision"]
    stroke = Element(id=element_id, type="freedraw", x=0, y=0, width=4, height=4)
    boards.apply(owner, sid, EditBatch(operation_id=uuid4(), expected_revision=revision,
                                       edits=[Edit(element=stroke, actor=actor, **({"source_revision": revision} if actor == "model" else {}))]))


def test_ink_evidence_must_be_human_authored(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"outcome": "correct"})
    BoardStore(capture).load(owner, sid)
    _scene(capture, owner, sid, "model", "tutor-ink")
    _scene(capture, owner, sid, "human", "my-ink")
    qid = waiting(client, sid, holder, {**FREE, "q": "Sketch it", "key": "a parabola"})
    rejected = answer(client, sid, qid, text="parabola", via="ink", element_ids=["tutor-ink"])
    assert rejected.status_code == 422 and rejected.json()["detail"] == "evidence_not_learner"
    assert answer(client, sid, qid, text="parabola", via="typed", element_ids=["my-ink"]).status_code == 422
    events(answer(client, sid, qid, text="parabola", via="ink", element_ids=["my-ink"]))
    [row] = settled(client, sid)
    assert row["modality"] == "ink" and row["observation"]["sources"][0]["element_ids"] == ["my-ink"]


def test_labeling_failure_is_in_the_trace_and_never_in_the_lesson(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler(fail="provider_auth_failed")
    qid = waiting(client, sid, holder, CHECK)
    got = events(answer(client, sid, qid, choice="the mean"))
    assert [n for n, _ in got if n == "error"] == [] and got[-1][1]["status"] == "done"
    assert "provider_auth_failed" not in json.dumps(got)
    [row] = settled(client, sid)
    assert row["status"] == "failed" and row["error"] == "provider_auth_failed"
    assert row["observation"]["outcome"] == "incorrect"  # the deterministic grade is still evidence


def test_unconfigured_labeler_charges_nothing(env):
    client, capture, owner, sid, holder = env
    holder.pop("labeler", None)
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    [row] = settled(client, sid)
    assert row["error"] == "labeler_not_configured"
    with capture.engine.connect() as conn:
        assert not [b for b in conn.exec_driver_sql("select bucket from learning_budgets").scalars() if b.startswith("label")]


def test_the_turn_never_waits_for_labeling(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler(delay=1.5)
    qid = waiting(client, sid, holder, CHECK)
    started = time.perf_counter()
    got = events(answer(client, sid, qid, choice="the mean"))
    assert time.perf_counter() - started < 1.0 and got[-1][1]["status"] == "done"
    assert trace(client, sid)["observations"][0]["status"] == "pending"
    assert settled(client, sid)[0]["status"] == "labeled"


def test_label_budget_is_charged_before_the_call(env, monkeypatch):
    client, capture, owner, sid, holder = env
    monkeypatch.setattr(observations, "HOURLY_LABELS", 1)
    holder["labeler"] = labeler = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    settled(client, sid)
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    rows = settled(client, sid, 2)
    assert [r["error"] for r in rows] == [None, "label_budget"] and len(labeler.calls) == 1


def test_labels_run_at_most_concurrency_at_a_time(env):
    client, capture, owner, sid, holder = env
    store = observations.ObservationStore(capture)
    active, peak = [0], [0]

    class Slow(FakeLabeler):
        async def label(self, state, asked, images=()):
            active[0] += 1
            peak[0] = max(peak[0], active[0])
            await asyncio.sleep(0.05)
            active[0] -= 1
            return await super().label(state, asked)

    labeler = Slow()
    q = {"kind": "mcq", "q": "q", "options": ["a", "b"], "key": "a", "concept": "c", "dim": "apply"}
    ids = [store.capture_answer(owner, str(sid), str(uuid4()), {**q, "qid": f"t.{i}"}, "b",
                                {"result": "incorrect", "verified": "incorrect"}, "tap", [])[0]["observation_id"] for i in range(observations.CONCURRENCY + 3)]

    async def run():
        await asyncio.gather(*(observations.label(store, labeler, owner, i) for i in ids))

    asyncio.run(run())
    assert peak[0] == observations.CONCURRENCY and len(labeler.calls) == observations.CONCURRENCY + 3


def test_evidence_trace_is_owner_scoped(env):
    client, capture, owner, sid, holder = env
    assert client.get(f"/learning/sessions/{uuid4()}/evidence").status_code == 404


# --- the Baseten client -------------------------------------------------------------------------

def _client(handler):
    return EvidenceLabeler("k", transport=httpx.MockTransport(handler))


ASKED = {"outcome": EVIDENCE_QUESTIONS["outcome"], "key_valid": EVIDENCE_QUESTIONS["key_valid"]}


def test_client_sends_choice_questions_and_maps_answers():
    sent = {}

    def handler(request):
        sent.update(json.loads(request.content), auth=request.headers["authorization"])
        return httpx.Response(200, json={"model": "decision-models/baseten-elephant-9b-latest", "usage": {"input_tokens": 9, "output_tokens": 0},
            "answers": {"outcome": {"type": "choice", "choice": "partial", "confidence": 0.7,
                                    "probabilities": {"correct": 0.1, "partial": 0.7, "incorrect": 0.15, "unanswered": 0.05}},
                        "key_valid": {"type": "choice", "choice": "valid", "confidence": 0.9,
                                      "probabilities": {"valid": 0.9, "invalid": 0.05, "unsure": 0.05}}}})

    result, _ = asyncio.run(_client(handler).label({"learner_answer": "x"}, ASKED))
    assert result.answers["outcome"].choice == "partial"
    assert sent["auth"] == "Bearer k" and sent["service_tier"] == "default"
    assert sent["questions"]["outcome"]["type"] == "choice" and set(sent["questions"]["outcome"]["criteria"]) == set(ASKED["outcome"][1])
    assert "untrusted" in sent["questions"]["outcome"]["instructions"]


@pytest.mark.parametrize("response,code", [
    (httpx.Response(403, json={"error": "please check the api-key you provided"}), "provider_auth_failed"),
    (httpx.Response(429), "provider_rate_limited"),
    (httpx.Response(500), "provider_http_error"),
    (httpx.Response(200, content=b"{\"model\": 1"), "provider_invalid_response"),
    (httpx.Response(200, json={"model": "decision-models/baseten-elephant-9b-latest", "usage": {"input_tokens": 1, "output_tokens": 0},
        "answers": {"outcome": {"type": "choice", "choice": "maybe", "probabilities": {"maybe": 1.0}},
                    "key_valid": {"type": "choice", "choice": "valid", "probabilities": {"valid": 1.0}}}}), "provider_invalid_response"),
])
def test_client_failures_map_to_safe_codes(response, code):
    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(_client(lambda request: response).label({}, ASKED))
    assert raised.value.code == code


def test_client_timeout_and_missing_key():
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(_client(slow).label({}, ASKED))
    assert raised.value.code == "provider_timeout"
    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(EvidenceLabeler("  ").label({}, ASKED))
    assert raised.value.code == "provider_not_configured"
