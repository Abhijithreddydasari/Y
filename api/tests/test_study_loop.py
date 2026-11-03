"""H7: warm-up reviews, exit ticket, hint ladder and the canvas list (all mocked)."""
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from learning import study
from learning.learner_contracts import Belief, MisconceptionEntry, ProfileRevision
from learning.learner_contracts import Observation
from test_evidence import FakeLabeler, answer, settled, trace, waiting  # noqa: F401
from test_learner_model import FakeNotes
from test_tutor_turn import CHECK, DONE, SEG, WAIT, WRITE, FakeTutor, ask, doc, env, events  # noqa: F401

NOW = datetime(2026, 11, 3, 10, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def one_loop(env):
    with env[0]:
        yield


def at(hours: float) -> str:
    return (NOW - timedelta(hours=hours)).isoformat()


def revision(beliefs, misconceptions=()):
    return ProfileRevision(revision=1, session_id=uuid4(), beliefs=tuple(beliefs), misconceptions=tuple(misconceptions),
                           observation_ids=(uuid4(),), created_at=NOW.isoformat())


def b(concept, alpha, beta, hours_ago, half_life=24.0, dim="understand"):
    return Belief(concept=concept, dimension=dim, alpha=alpha, beta=beta, half_life_hours=half_life, last_evidence_at=at(hours_ago))


# --- due selection --------------------------------------------------------------------------------

def test_due_by_misconception_fading_retention_or_shaky_mean():
    entry = MisconceptionEntry(id="a.mis/x", concept="a.mis", description="believes x", status="suspected",
                               strength=0.2, evidence=(uuid4(),))
    rev = revision([b("a.known", 9, 1, 1), b("a.fading", 9, 1, 48), b("a.shaky", 1, 2, 0.1), b("a.mis", 8, 2, 0.1)], [entry])
    due = study.due_concepts(rev, NOW.isoformat())
    assert [d["concept"] for d in due] == ["a.mis", "a.fading", "a.shaky"]
    assert [d["reason"] for d in due] == ["misconception", "fading", "shaky"]
    assert due[1]["retention"] == 0.25  # two half-lives
    assert study.due_concepts(None) == []


def test_review_items_need_a_stored_check_and_skip_reviewed():
    rev = revision([b("a.one", 1, 3, 1), b("a.two", 1, 3, 1), b("a.three", 1, 3, 1)])
    checks = {"a.one": {"q": "Q1"}, "a.three": {"q": "Q3"}}
    items = study.review_items(rev, checks, {"a.three"}, NOW.isoformat())
    assert [(i["concept"], i["q"]) for i in items] == [("a.one", "Q1")]
    assert "key" not in json.dumps(items)


def test_hint_leak_and_shape_rules():
    mcq = {"kind": "mcq", "key": "variance"}
    assert study.parse_hint('{"hint": "Think about the spread of q·k."}', mcq) == "Think about the spread of q·k."
    for bad in ('{"hint": "It is the Variance."}', '{"hint": ""}', "not json"):
        with pytest.raises(study.StoreError):
            study.parse_hint(bad, mcq)
    assert study.parse_hint('{"hint": "Pick 4 numbers"}', {"kind": "mcq", "key": "4"})  # short keys are not scanned
    messages = study.hint_messages({"q": "Q", "kind": "mcq", "options": ["a"], "key": "a"}, 1, [])
    assert "NUDGE" in messages[0]["content"] and "Do not state the answer" in messages[0]["content"]


# --- routes ---------------------------------------------------------------------------------------

def sealed_session_one(client, capture, owner, sid, holder):
    """Session 1: one wrong answer on CHECK, sealed. Returns session 2's id."""
    holder["labeler"] = FakeLabeler({"misconception": "attention.scaling/the-mean", "miss_class": "discrimination"})
    holder["notes"] = FakeNotes()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    settled(client, sid)
    assert client.post(f"/learning/sessions/{sid}/close").json()["profile_updated"]
    two = uuid4()
    capture.create_session(owner, two)
    return two


def review(client, sid, concept):
    return client.post(f"/learning/sessions/{sid}/tutor/turns",
                       json={"turn_id": str(uuid4()), "kind": "review", "concept": concept})


def test_warm_up_re_asks_the_earlier_check_without_a_model_call_and_records_evidence(env):
    client, capture, owner, sid, holder = env
    two = sealed_session_one(client, capture, owner, sid, holder)
    items = client.get(f"/learning/sessions/{two}/review").json()["items"]
    assert [i["concept"] for i in items] == ["attention.scaling"] and items[0]["reason"] == "misconception"
    assert items[0]["q"] == CHECK["q"]
    holder["tutor"] = tutor = FakeTutor([doc(WRITE, DONE)])
    got = events(review(client, two, "attention.scaling"))
    assert tutor.calls == []  # drawn from storage
    moves = [v["move"] for n, v in got if n == "move"]
    assert [m["type"] for m in moves] == ["seg", "check", "turn_end"] and "key" not in json.dumps(got)
    done = got[-1][1]
    assert done["status"] == "waiting" and done["question"]["origin"] == "review"
    assert client.get(f"/learning/sessions/{two}/review").json()["items"] == []  # offered once per session
    events(answer(client, two, done["question"]["qid"], choice="variance"))
    feedback = tutor.calls[0][1]["content"][-1]["text"]
    assert '"origin":"review"' in feedback and "without a new predict or check" in feedback
    [row] = settled(client, two)
    observation = Observation.model_validate(row["observation"])
    assert observation.outcome == "correct" and observation.concept == "attention.scaling"
    assert review(client, two, "nope.missing").status_code == 404


def test_review_prefers_the_latest_missed_check_over_a_later_correct_one(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"misconception": "attention.scaling/the-mean", "miss_class": "discrimination"})
    holder["notes"] = FakeNotes()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    later = {**CHECK, "q": "Which one grows with d_k, again?"}
    qid = waiting(client, sid, holder, later)
    events(answer(client, sid, qid, choice="variance"))
    settled(client, sid, 2)
    client.post(f"/learning/sessions/{sid}/close")
    two = uuid4()
    capture.create_session(owner, two)
    [item] = client.get(f"/learning/sessions/{two}/review").json()["items"]
    assert item["q"] == CHECK["q"]


def test_predicts_never_make_a_review(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler()
    holder["notes"] = FakeNotes()
    predict = {"type": "predict", "q": "Bigger or smaller?", "options": ["bigger", "smaller"], "answer": "bigger"}
    qid = waiting(client, sid, holder, predict)
    events(answer(client, sid, qid, choice="smaller"))
    settled(client, sid)
    client.post(f"/learning/sessions/{sid}/close")
    two = uuid4()
    capture.create_session(owner, two)
    assert client.get(f"/learning/sessions/{two}/review").json()["items"] == []


def test_exit_ticket_names_the_session_concept_and_its_answer_closes_briefly(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="variance"))
    holder["tutor"] = tutor = FakeTutor([doc(SEG, CHECK, WAIT), doc(WRITE, DONE)])
    got = events(client.post(f"/learning/sessions/{sid}/tutor/turns", json={"turn_id": str(uuid4()), "kind": "exit"}))
    sent = json.loads(tutor.calls[0][1]["content"][-1]["text"].split("\n", 1)[1])
    assert sent["kind"] == "exit_ticket" and sent["concept"] == "attention.scaling"
    question = got[-1][1]["question"]
    assert question["origin"] == "exit"
    assert client.get(f"/learning/sessions/{sid}/tutor").json()["open"]["origin"] == "exit"
    events(answer(client, sid, question["qid"], choice="variance"))
    assert "the session closes next" in tutor.calls[1][1]["content"][-1]["text"]
    assert len(settled(client, sid, 2)) == 2


class HintTutor(FakeTutor):
    def __init__(self, replies, documents=()):
        super().__init__(documents)
        self.replies, self.hint_calls = list(replies), []

    async def complete(self, messages, max_tokens=1500, fmt=None):
        self.hint_calls.append((messages, max_tokens, fmt))
        return self.replies.pop(0)


def test_hint_ladder_in_order_stored_once_and_counted_as_assistance(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler()
    qid = waiting(client, sid, holder, CHECK)
    feedback = holder["tutor"]
    holder["tutor"] = tutor = HintTutor(['{"hint": "Look at how the sum spreads."}', '{"hint": "Each of the d_k terms adds a spread of 1."}'])
    url = f"/learning/sessions/{sid}/tutor/hints"
    assert client.post(url, json={"qid": qid, "level": 2}).json()["detail"] == "hint_out_of_order"
    first = client.post(url, json={"qid": qid, "level": 1}).json()
    assert first["hints"] == [{"level": 1, "text": "Look at how the sum spreads."}] and not first["replayed"]
    assert client.post(url, json={"qid": qid, "level": 1}).json()["replayed"]  # no second call
    second = client.post(url, json={"qid": qid, "level": 2}).json()
    assert [h["level"] for h in second["hints"]] == [1, 2] and len(tutor.hint_calls) == 2
    messages, tokens, fmt = tutor.hint_calls[1]
    assert fmt == study.HINT_FORMAT and tokens == study.HINT_TOKENS
    assert "Look at how the sum spreads." in messages[1]["content"]  # builds on the earlier hint
    assert client.get(f"/learning/sessions/{sid}/tutor").json()["open"]["hints"][1]["level"] == 2
    assert client.post(url, json={"qid": "x.1", "level": 1}).json()["detail"] == "tutor_question_not_open"
    holder["tutor"] = feedback
    events(answer(client, sid, qid, choice="variance"))
    [row] = settled(client, sid)
    observation = Observation.model_validate(row["observation"])
    assert observation.assistance.hint_ids == ("hint:1", "hint:2")


def test_a_leaking_hint_is_refused_and_not_stored(env):
    client, capture, owner, sid, holder = env
    qid = waiting(client, sid, holder, CHECK)
    holder["tutor"] = HintTutor(['{"hint": "The answer is variance."}'])
    response = client.post(f"/learning/sessions/{sid}/tutor/hints", json={"qid": qid, "level": 1})
    assert response.status_code == 502 and response.json()["detail"] == "hint_leaked"
    assert client.get(f"/learning/sessions/{sid}/tutor").json()["open"]["hints"] == []


def test_canvas_list_titles_sessions_and_marks_sealed(env):
    client, capture, owner, sid, holder = env
    two = sealed_session_one(client, capture, owner, sid, holder)
    listed = client.get("/learning/canvases").json()["canvases"]
    by_id = {c["session_id"]: c for c in listed}
    assert by_id[str(sid)]["sealed"] and by_id[str(sid)]["title"] == "Why divide by root d_k?" and by_id[str(sid)]["turns"] == 2
    assert not by_id[str(two)]["sealed"] and by_id[str(two)]["title"] == "Untitled canvas"
    # A canvas that began (and so far only ran) a warm-up is named by the check it re-asked.
    events(review(client, two, CHECK["concept"]))
    listed = {c["session_id"]: c for c in client.get("/learning/canvases").json()["canvases"]}
    assert listed[str(two)]["title"] == f"Warm-up: {CHECK['q']}"
    # Another owner sees none of these.
    other = capture.issue_identity()
    client.cookies.set("y_learning_identity", other)
    assert client.get("/learning/canvases").json()["canvases"] == []


def test_closed_session_offers_no_review_and_refuses_hints(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = HintTutor([])
    client.post(f"/learning/sessions/{sid}/close")
    assert client.get(f"/learning/sessions/{sid}/review").json() == {"items": []}
    response = client.post(f"/learning/sessions/{sid}/tutor/hints", json={"qid": "a.1", "level": 1})
    assert response.status_code == 409 and response.json()["detail"] == "session_closed"
