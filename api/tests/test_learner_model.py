"""H5: seal a session into one profile revision, brief the next session, Memory on/off (all mocked)."""
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
import pytest

from learning import profile
from learning.consolidate import NotesWriter, keep_cited
from learning.contracts import Assistance
from learning.decisions import ProviderFailure
from learning.learner_contracts import EvidenceSource, Observation, TeachingNote
from learning.storage import StoreError
from test_evidence import FakeLabeler, answer, settled, trace, waiting  # noqa: F401
from test_tutor_turn import CHECK, DONE, SEG, WAIT, WRITE, FakeTutor, ask, doc, env, events  # noqa: F401

S1, S2, S3 = (str(uuid4()) for _ in range(3))
T0 = datetime(2026, 11, 1, 10, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def one_loop(env):
    with env[0]:
        yield


def obs(outcome="correct", concept="attention.softmax", dim="understand", hours=0.0, **kw):
    return Observation(observation_id=uuid4(), session_id=uuid4(), check_id=f"t.{uuid4().hex[:6]}", concept=concept,
                       dimension=dim, outcome=outcome, labeler="deterministic", label_confidence=kw.pop("lc", 1.0),
                       sources=(EvidenceSource(event_id=uuid4(), modality="tap", content_hash="0" * 64),),
                       created_at=(T0 + timedelta(hours=hours)).isoformat().replace("+00:00", "Z"), **kw)


def belief(revision, concept="attention.softmax", dim="understand"):
    return next(b for b in revision.beliefs if (b.concept, b.dimension) == (concept, dim))


# --- reducer ------------------------------------------------------------------------------------

def test_beta_update_weights_and_key_status():
    rev, index = profile.reduce(None, {}, [obs(), obs("incorrect"), obs("partial"), obs(key_status="wrong"),
                                           obs(key_status="suspect"), obs(format_weight=0.5)], S1)
    b = belief(rev)
    # correct 1 + partial 0.5 + suspect 0.5 + half-weight 0.5 ; incorrect 1 + partial 0.5; the wrong key adds nothing
    assert b.alpha == pytest.approx(1 + 1 + 0.5 + 0.5 + 0.5) and b.beta == pytest.approx(1 + 1 + 0.5)
    assert index["attention.softmax|understand"]["total"] == 5 and len(rev.observation_ids) == 6
    assert rev.revision == 1 and rev.parent_revision is None


def test_hints_and_label_confidence_down_weight():
    hinted = obs(assistance=Assistance(hint_ids=("h1",)))
    unsure = obs(lc=0.6)
    assert profile.weight(hinted) == pytest.approx(0.7) and profile.weight(unsure) == pytest.approx(0.6)


def test_half_life_doubles_on_spaced_recall_halves_on_a_miss_and_decays():
    first, idx = profile.reduce(None, {}, [obs(hours=0)], S1)
    assert belief(first).half_life_hours == 24
    second, idx = profile.reduce(first, idx, [obs(hours=30)], S2)
    assert belief(second).half_life_hours == 48 and second.parent_revision == 1
    missed, _ = profile.reduce(second, idx, [obs("incorrect", hours=31)], S3)
    assert belief(missed).half_life_hours == 24
    # 24 h later at half-life 24 the earlier evidence keeps half its weight
    decayed, _ = profile.reduce(first, {}, [obs("incorrect", hours=24)], S2)
    assert belief(decayed).alpha == pytest.approx(1.5) and belief(decayed).beta == pytest.approx(2.0)


def test_misconception_ledger_activates_and_resolves():
    mid = "attention.softmax/the-mean"
    seen, idx = profile.reduce(None, {}, [obs("incorrect", misconception=mid, miss_class="discrimination")], S1)
    [entry] = seen.misconceptions
    assert entry.status == "active" and entry.description.startswith("On attention.softmax")
    once, _ = profile.reduce(seen, idx, [obs(hours=30)], S2)
    assert once.misconceptions[0].status == "active"
    twice, _ = profile.reduce(seen, idx, [obs(hours=30), obs(hours=31)], S2)
    assert twice.misconceptions[0].status == "resolved"


def test_reducer_is_deterministic():
    items = [obs(), obs("incorrect", hours=1)]
    a = profile.reduce(None, {}, items, S1, at="2026-11-02T00:00:00Z")
    b = profile.reduce(None, {}, list(reversed(items)), S1, at="2026-11-02T00:00:00Z")
    assert a[0] == b[0] and a[1] == b[1]


# --- brief and notes ----------------------------------------------------------------------------

def test_brief_cites_evidence_ranks_by_topic_and_stays_bounded():
    mid = "attention.softmax/the-mean"
    items = [obs(), obs(), obs(concept="linalg.dot"), obs("incorrect", misconception=mid, miss_class="discrimination"),
             obs(concept="attention.scaling", dim="apply"), obs("incorrect", concept="attention.scaling", dim="apply")]
    note = TeachingNote(text="Start from the softmax picture; re-check the mean confusion.", cites=(items[3].observation_id,))
    rev, idx = profile.reduce(None, {}, items, S1, notes=[note])
    brief = profile.compile_brief(rev, idx, "How does multi-head attention work?", now="2026-11-01T12:00:00Z")
    kinds = {i.id: i.kind for i in brief.items}
    assert kinds["M1"] == "misconception" and "N1" in kinds and any(k.startswith("S") for k in kinds)
    assert all(i.evidence for i in brief.items) and brief.profile_revision == 1
    assert brief.items[0].concept.startswith("attention")  # shares a word with the question
    text = profile.render_brief(brief)
    assert "M1 [misconception]" in text and len(text) < 2400 + 200
    assert profile.compile_brief(None, {}, "anything") is None


def test_brief_marks_due_recall_and_respects_the_budget():
    rev, idx = profile.reduce(None, {}, [obs(), obs(), obs()], S1)
    due = profile.compile_brief(rev, idx, "softmax", now="2026-11-05T00:00:00Z")
    assert "due for review" in due.items[0].text
    many = [obs(concept=f"topic.c{i:02d}") for i in range(60)]
    big, bidx = profile.reduce(None, {}, many, S1)
    brief = profile.compile_brief(big, bidx, "x", now="2026-11-01T11:00:00Z")
    assert len(brief.items) <= 24 and sum(len(i.text) for i in brief.items) <= 2400


def test_uncited_and_foreign_notes_are_dropped():
    mine = str(uuid4())
    kept, dropped = keep_cited({"notes": [{"text": "Build on dot products.", "cites": [mine, "x"]},
                                          {"text": "Uncited.", "cites": []},
                                          {"text": "Foreign.", "cites": [str(uuid4())]}]}, {mine})
    assert [n.text for n in kept] == ["Build on dot products."] and dropped == 2
    assert keep_cited("garbage", {mine}) == ([], 0)


def test_notes_writer_request_shape_and_one_retry_on_empty():
    sent, replies = [], [{"choices": [{"message": {"content": ""}}]},
                         {"choices": [{"message": {"content": "{\"notes\": []}"}}]}]

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json=replies.pop(0))

    import asyncio
    writer = NotesWriter(httpx.AsyncClient(transport=httpx.MockTransport(handler)), api_key="k")
    raw, trace_ = asyncio.run(writer.write({"observations": []}))
    assert raw == {"notes": []} and trace_["attempts"] == 2
    body = sent[0]
    assert body["model"] == "meta-models/muse-spark-open-1026" and body["response_format"]["json_schema"]["strict"]
    assert body["max_tokens"] == 3000 and "untrusted" in body["messages"][0]["content"]
    with pytest.raises(ProviderFailure) as raised:
        asyncio.run(NotesWriter(api_key="").write({}))
    assert raised.value.code == "provider_not_configured"


# --- the two-session arc --------------------------------------------------------------------------

class FakeNotes:
    def __init__(self, cite_first=True, fail=None):
        self.cite_first, self.fail, self.payloads = cite_first, fail, []

    async def write(self, payload):
        self.payloads.append(payload)
        if self.fail:
            raise ProviderFailure(self.fail)
        first = payload["observations"][0]["id"]
        return {"notes": [{"text": "Confront the mean-vs-weights mix-up with a two-token example.", "cites": [first]},
                          {"text": "Invented.", "cites": [str(uuid4())]}]}, {"model": "fake", "attempts": 1, "ms": 1}


MIS = "attention.scaling/the-mean"


def session_one(client, sid, holder):
    holder["labeler"] = FakeLabeler({"misconception": MIS, "miss_class": "discrimination"})
    holder["notes"] = notes = FakeNotes()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    settled(client, sid)
    return notes


def test_close_seals_once_and_replays_without_double_counting(env):
    client, capture, owner, sid, holder = env
    notes = session_one(client, sid, holder)
    first = client.post(f"/learning/sessions/{sid}/close")
    assert first.status_code == 200
    body = first.json()
    assert body["profile_updated"] and not body["replayed"] and body["revision"] == 1 and body["sealed"] == 1
    assert body["misconceptions"] == [MIS] and len(body["notes"]) == 1 and body["notes_trace"]["dropped"] == 1
    revision, _ = profile.ProfileStore(capture).latest(owner)
    assert revision.misconceptions[0].description == "On attention.scaling: believes the mean"
    assert notes.payloads[0]["observations"][0]["learner_answer"] == "the mean"
    again = client.post(f"/learning/sessions/{sid}/close").json()
    assert again["replayed"] and again["revision"] == 1 and again["sealed"] == 1 and len(notes.payloads) == 1
    store = profile.ProfileStore(capture)
    revision, index = store.latest(owner)
    assert revision.revision == 1 and index["attention.scaling|understand"]["total"] == 1
    assert trace(client, sid)["profile_updated"] is True and trace(client, sid)["profile_revision"] == 1
    late = ask(client, sid)[1]
    assert late.status_code == 409 and late.json()["detail"] == "session_closed"


def test_a_close_in_progress_blocks_a_second_one(env):
    client, capture, owner, sid, holder = env
    store = profile.ProfileStore(capture)
    assert store.begin_close(owner, str(sid)) == "claimed"
    with pytest.raises(StoreError) as raised:
        store.begin_close(owner, str(sid))
    assert raised.value.code == "session_closing"
    store.abort_close(str(sid))
    assert store.begin_close(owner, str(sid)) == "claimed"


def test_close_relabels_failed_rows_and_survives_a_notes_failure(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler(fail="provider_auth_failed")
    holder["notes"] = FakeNotes(fail="provider_timeout")
    qid = waiting(client, sid, holder, {**CHECK, "kind": "free", "options": [], "q": "Why scale?", "key": "variance grows"})
    events(answer(client, sid, qid, text="so it trains faster"))
    [row] = settled(client, sid)
    assert row["status"] == "failed" and row["observation"] is None
    holder["labeler"] = FakeLabeler({"outcome": "incorrect", "miss_class": "structural"})
    body = client.post(f"/learning/sessions/{sid}/close").json()
    assert body["relabel"]["requeued"] == 1 and body["sealed"] == 1 and body["notes"] == []
    assert body["notes_trace"] == {"error": "provider_timeout"} and body["profile_updated"]


def test_empty_session_closes_without_a_revision(env):
    client, capture, owner, sid, holder = env
    body = client.post(f"/learning/sessions/{sid}/close").json()
    assert body["profile_updated"] is False and body["revision"] is None
    assert client.post(f"/learning/sessions/{sid}/close").json()["replayed"] is True


BECAUSE = {"type": "because", "refs": ["M1"], "text": "You mixed up the mean and the weights last time"}


def test_session_two_opens_from_session_one_and_memory_off_is_generic(env):
    client, capture, owner, sid, holder = env
    session_one(client, sid, holder)
    client.post(f"/learning/sessions/{sid}/close")

    two = uuid4()
    capture.create_session(owner, two)
    holder["tutor"] = tutor = FakeTutor([doc(SEG, BECAUSE, WRITE, DONE)])
    got = events(ask(client, two, "How does multi-head attention work?")[1])
    sent = tutor.calls[0][1]["content"][0]["text"]
    assert sent.startswith("LEARNER BRIEF\nFrom earlier sessions") and "M1 [misconception]" in sent and "N1 [note]" in sent
    moves = [v["move"] for n, v in got if n == "move"]
    assert [m["type"] for m in moves] == ["seg", "because", "write", "turn_end"]
    done = got[-1][1]
    assert done["memory"]["on"] and done["memory"]["revision"] == 1 and done["memory"]["items"][0]["id"] == "M1"
    # A later turn in the same session reuses the same brief.
    holder["tutor"] = tutor = FakeTutor([doc(SEG, WRITE, DONE)])
    events(ask(client, two, "And the heads?")[1])
    assert "M1 [misconception]" in tutor.calls[0][1]["content"][0]["text"]

    three = uuid4()
    capture.create_session(owner, three)
    assert client.put(f"/learning/sessions/{three}/memory", json={"memory": False}).json()["memory"] is False
    holder["tutor"] = tutor = FakeTutor([doc(SEG, BECAUSE, WRITE, DONE)])
    got = events(ask(client, three, "How does multi-head attention work?")[1])
    assert tutor.calls[0][1]["content"][0]["text"] == "LEARNER BRIEF\nnone yet"
    assert [v["move"]["type"] for n, v in got if n == "move"] == ["seg", "write", "turn_end"]  # because dropped
    assert got[-1][1]["memory"] == {"on": False, "revision": None, "items": []} and got[-1][1]["dropped"] == 1
    assert tutor.repair_calls == []  # an uncitable because is dropped, never repaired


def test_profile_route_and_owner_scope(env):
    client, capture, owner, sid, holder = env
    assert client.get("/learning/profile").json() == {"revision": None, "brief": None, "brief_text": ""}
    session_one(client, sid, holder)
    client.post(f"/learning/sessions/{sid}/close")
    got = client.get("/learning/profile", params={"q": "attention"}).json()
    assert got["revision"]["revision"] == 1 and got["brief"]["items"][0]["id"] == "M1"
    assert client.post(f"/learning/sessions/{uuid4()}/close").status_code == 404
    assert client.put(f"/learning/sessions/{uuid4()}/memory", json={"memory": False}).status_code == 404


# --- probability-weighted updates and named misconceptions ------------------------------------------

def test_belief_moves_by_expected_credit_not_the_top_choice():
    unsure = obs("correct", outcome_p={"correct": 0.55, "partial": 0.4, "incorrect": 0.05, "unanswered": 0.0}, lc=0.55)
    assert profile.credit(unsure) == pytest.approx(0.75) and profile.weight(unsure) == 1.0
    rev, index = profile.reduce(None, {}, [unsure], S1)
    assert belief(rev).alpha == pytest.approx(1.75) and belief(rev).beta == pytest.approx(1.25)
    assert index["attention.softmax|understand"]["right"] == pytest.approx(0.75)
    # An older hard label still moves by its top choice scaled by its confidence.
    hard, _ = profile.reduce(None, {}, [obs("correct", lc=0.55)], S1)
    assert belief(hard).alpha == pytest.approx(1.55) and belief(hard).beta == pytest.approx(1.0)


def test_misconception_mass_accumulates_from_suspected_to_active():
    mid = "attention.softmax/the-mean"
    weak = obs("incorrect", misconception_p={mid: 0.6}, other_misconception_p=0.1, format_weight=0.5)  # mass 0.3
    first, idx = profile.reduce(None, {}, [weak], S1)
    [entry] = first.misconceptions
    assert entry.status == "suspected" and entry.strength == pytest.approx(0.3)
    item = next(i for i in profile.compile_brief(first, idx, "softmax").items if i.kind == "misconception")
    assert item.text.startswith("Possibly (not yet confirmed)") and item.id == "M1"
    again, _ = profile.reduce(first, idx, [obs("incorrect", misconception_p={mid: 0.8}, other_misconception_p=0.0,
                                               hours=30)], S2)
    assert again.misconceptions[0].status == "active" and again.misconceptions[0].strength == pytest.approx(1.1)
    faint, _ = profile.reduce(None, {}, [obs("incorrect", misconception_p={mid: 0.1}, other_misconception_p=0.0)], S1)
    assert faint.misconceptions == ()  # below one sighting
    right, _ = profile.reduce(None, {}, [obs("correct", outcome_p={"correct": 0.9, "partial": 0.1, "incorrect": 0.0,
                                                                  "unanswered": 0.0}, misconception_p={mid: 0.9})], S1)
    assert right.misconceptions == ()  # a likely-right answer gives a misconception little mass


def test_soft_resolution_needs_two_answers_worth_of_clean_credit():
    mid = "attention.softmax/the-mean"
    seen, idx = profile.reduce(None, {}, [obs("incorrect", misconception=mid, miss_class="discrimination")], S1)
    three_quarters = {"correct": 0.6, "partial": 0.3, "incorrect": 0.1, "unanswered": 0.0}
    two, _ = profile.reduce(seen, idx, [obs(outcome_p=three_quarters, hours=30, misconception_p={}),
                                        obs(outcome_p=three_quarters, hours=31, misconception_p={})], S2)
    assert two.misconceptions[0].status == "active"  # 1.5 of 2
    three, _ = profile.reduce(seen, idx, [obs(outcome_p=three_quarters, hours=30 + h, misconception_p={})
                                          for h in range(3)], S2)
    assert three.misconceptions[0].status == "resolved"
    recurred, _ = profile.reduce(seen, idx, [obs(hours=30), obs(hours=31), obs(hours=32),
                                             obs("incorrect", misconception_p={mid: 0.5}, other_misconception_p=0.0,
                                                 hours=33)], S2)
    assert recurred.misconceptions[0].status == "active"


def test_wrong_answers_are_grouped_into_one_named_belief_at_close():
    from learning.consolidate import evidence_payload, keep_named
    seven = obs("incorrect", concept="prob.independence", misconception_p={"prob.independence/7-12": 0.9},
                other_misconception_p=0.05)
    point7 = obs("incorrect", concept="prob.independence", misconception_p={"prob.independence/0-7": 0.4},
                 other_misconception_p=0.0, hours=1)
    drift = obs("incorrect", concept="prob.multiply", misconception_p={}, other_misconception_p=0.8, hours=2)
    slip = obs("incorrect", misconception_p={}, other_misconception_p=0.1)
    a, b, c, d = (str(x.observation_id) for x in (seven, point7, drift, slip))
    raw = {"notes": [], "misconceptions": [
        {"text": "adds the probabilities of independent events.", "cites": [a, b, c]},
        {"text": "again", "cites": [a]},  # every answer joins one belief
        {"text": "a slip", "cites": [d]},  # not flagged
        {"text": "", "cites": [c]}]}
    named, dropped = keep_named(raw, [seven, point7, drift, slip])
    assert dropped == 3 and len(named) == 1
    belief_ = named[0]
    assert belief_["id"] == "prob.independence/belief-adds-the-probabilities-of-independent-ev"
    assert belief_["evidence"] == [a, b, c] and belief_["mass"] == 2.0  # 0.95 + 0.4 + 0.8, capped
    rev, _ = profile.reduce(None, {}, [seven, point7, drift, slip], S1, named=named)
    # The option-shaped sightings are absorbed: one active belief, not three weak entries.
    [entry] = rev.misconceptions
    assert entry.status == "active" and entry.description == "On prob.independence: adds the probabilities of independent events"
    marks = [row["misconception_signal"] for row in evidence_payload([seven, slip], {}, [])["observations"]]
    assert marks == [True, False]


def test_reasoning_quality_is_tallied_apart_from_mastery_and_briefed():
    a, b = obs(reasoning=0.4, reasoning_shown=0.9), obs(reasoning=0.2, reasoning_shown=0.5)
    rev, idx = profile.reduce(None, {}, [a, b], S1)
    assert idx["reasoning|attention.softmax"]["seen"] == pytest.approx(1.4)
    assert belief(rev).alpha == pytest.approx(3.0)  # reasoning never changes mastery
    item = next(i for i in profile.compile_brief(rev, idx, "softmax").items if i.text.startswith("Reasoning"))
    assert item.kind == "shaky" and "mostly surface-level" in item.text and "explain why" in item.text


class NamingNotes(FakeNotes):
    async def write(self, payload):
        self.payloads.append(payload)
        mark = next(o["id"] for o in payload["observations"] if o["misconception_signal"])
        return {"notes": [], "misconceptions": [{"text": "thinks the scale factor is learned", "cites": [mark]}]}, \
            {"model": "fake", "attempts": 1, "ms": 1}


def test_close_names_an_unlisted_misconception_and_session_two_offers_it_to_the_labeler(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"misconception": "other", "miss_class": "structural"})
    holder["notes"] = NamingNotes()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="nothing"))
    settled(client, sid)
    body = client.post(f"/learning/sessions/{sid}/close").json()
    named = "attention.scaling/belief-thinks-the-scale-factor-is-learned"
    assert body["notes_trace"]["named"] == [named] and body["misconceptions"] == [named]

    two = uuid4()
    capture.create_session(owner, two)
    holder["labeler"] = labeler = FakeLabeler()
    holder["notes"] = FakeNotes()
    qid = waiting(client, two, holder, {**CHECK, "q": "Where does 1/sqrt(d_k) come from?", "key": "a fixed choice",
                                        "options": ["a fixed choice", "training"]})
    events(answer(client, two, qid, choice="training"))
    settled(client, two)
    candidates = labeler.calls[0][1]["misconception"][1]
    assert candidates[named].startswith("Seen in an earlier session. On attention.scaling: thinks")
