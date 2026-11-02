"""H6: reasoning links written at close and the revision history behind the learner map (all mocked)."""
from uuid import uuid4

import pytest

from learning import profile
from learning.consolidate import bridges, keep_links
from learning.observations import ObservationStore
from test_evidence import FakeLabeler, answer, settled, waiting  # noqa: F401
from test_learner_model import S1, S2, FakeNotes, obs, one_loop  # noqa: F401
from test_tutor_turn import CHECK, env, events  # noqa: F401


def test_links_need_known_ends_and_cites_on_either_end():
    soft, dot, other = obs(), obs(concept="linalg.dot"), obs(concept="prob.bayes")
    a, b, c = (str(x.observation_id) for x in (soft, dot, other))
    raw = {"links": [
        {"from": "linalg.dot", "to": "attention.softmax", "kind": "builds_on", "why": " Used  dot products. ", "cites": [a, b]},
        {"from": "linalg.dot", "to": "attention.softmax", "kind": "builds_on", "why": "Uncited.", "cites": []},
        {"from": "linalg.dot", "to": "linalg.dot", "kind": "builds_on", "why": "Self.", "cites": [b]},
        {"from": "linalg.dot", "to": "made.up", "kind": "builds_on", "why": "Unknown end.", "cites": [b]},
        {"from": "linalg.dot", "to": "attention.softmax", "kind": "builds_on", "why": "Off-topic cite.", "cites": [c]},
        {"from": "linalg.vectors", "to": "linalg.dot", "kind": "confused_with", "why": "Earlier concept.", "cites": [b]},
        {"from": "linalg.dot", "to": "attention.softmax", "kind": "related", "why": "Bad kind.", "cites": [a]}]}
    kept, dropped = keep_links(raw, [soft, dot, other], {"linalg.vectors"})
    assert dropped == 5 and [k["why"] for k in kept] == ["Used dot products.", "Earlier concept."]
    assert kept[0]["provenance"] == "model" and kept[0]["evidence"] == [a, b]
    assert keep_links("not json", [soft], set()) == ([], 0)


def test_a_named_belief_spanning_concepts_bridges_them():
    one, two = obs("incorrect"), obs("incorrect", concept="attention.scaling")
    named = [{"id": "attention.softmax/belief-x", "concept": "attention.softmax",
              "description": "On attention.softmax: thinks the weights are equal", "mass": 1.0,
              "evidence": [str(one.observation_id), str(two.observation_id)]}]
    [link] = bridges(named, [one, two])
    assert (link["source"], link["target"], link["kind"], link["provenance"]) == \
        ("attention.softmax", "attention.scaling", "confused_with", "system")
    assert link["why"].endswith("thinks the weights are equal") and len(link["evidence"]) == 2
    assert bridges([{**named[0], "evidence": [str(one.observation_id)]}], [one]) == []


def test_links_carry_forward_merge_and_never_touch_beliefs():
    first, second = obs(concept="linalg.dot"), obs(hours=1)
    ids = [str(first.observation_id), str(second.observation_id)]
    link = {"source": "linalg.dot", "target": "attention.softmax", "kind": "builds_on", "why": "Used dot products.",
            "evidence": ids, "provenance": "model"}
    plain, _ = profile.reduce(None, {}, [first, second], S1)
    one, idx = profile.reduce(None, {}, [first, second], S1, links=[link])
    assert one.beliefs == plain.beliefs and one.misconceptions == plain.misconceptions
    [k] = one.links
    assert k.strength == pytest.approx(2.0) and k.first_revision == 1
    third = obs(hours=30)
    confused = {"source": "attention.softmax", "target": "attention.scaling", "kind": "confused_with",
                "why": "Mixed them up.", "evidence": [str(third.observation_id)], "provenance": "system"}
    again = {**link, "why": "Built on dot products again.", "evidence": [str(third.observation_id), ids[0]]}
    two, _ = profile.reduce(one, idx, [third], S2, links=[again, confused])
    by = {(k.source, k.target, k.kind): k for k in two.links}
    merged = by[("linalg.dot", "attention.softmax", "builds_on")]
    # Only this session's answers add strength; the earlier cite is not counted twice.
    assert merged.strength == pytest.approx(3.0) and merged.why == "Built on dot products again." and merged.first_revision == 1
    assert by[("attention.scaling", "attention.softmax", "confused_with")].first_revision == 2  # stored unordered
    replay, _ = profile.reduce(one, idx, [third], S2, links=[confused, again], at=two.created_at)
    assert replay.links == two.links


class LinkingNotes(FakeNotes):
    async def write(self, payload):
        self.payloads.append(payload)
        first = payload["observations"][0]
        return {"notes": [{"text": "Build on the dot-product picture.", "cites": [first["id"]]}], "misconceptions": [],
                "links": [{"from": "linalg.dot", "to": first["concept"], "kind": "builds_on",
                           "why": "Reasoned from dot products.", "cites": [first["id"]]},
                          {"from": first["concept"], "to": "nowhere.x", "kind": "builds_on", "why": "Bad.",
                           "cites": [first["id"]]}]}, {"model": "fake", "attempts": 1, "ms": 1}


def test_close_keeps_cited_links_and_the_history_route_serves_revisions_and_events(env):
    client, capture, owner, sid, holder = env
    store = profile.ProfileStore(capture)
    # An earlier revision makes linalg.dot a known concept.
    earlier, idx = profile.reduce(None, {}, [obs(concept="linalg.dot")], str(uuid4()))
    other = uuid4()
    capture.create_session(owner, other)
    store.write(owner, str(other), lambda prev, index: (earlier, idx, {}))
    holder["labeler"] = FakeLabeler()
    holder["notes"] = notes = LinkingNotes()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="the mean"))
    settled(client, sid)
    body = client.post(f"/learning/sessions/{sid}/close").json()
    assert body["revision"] == 2 and body["links"] == 1 and body["notes_trace"]["links_dropped"] == 1
    assert "linalg.dot" in notes.payloads[0]["known_concepts"]
    history = client.get("/learning/profile/revisions").json()
    assert [r["revision"] for r in history["revisions"]] == [1, 2]
    [link] = history["revisions"][1]["links"]
    assert link["source"] == "linalg.dot" and link["provenance"] == "model" and link["first_revision"] == 2
    [event] = history["events"]
    assert event["question"] == CHECK["q"][:160] and event["answer"] == "the mean" and event["modality"] == "tap"
    assert event["id"] == link["evidence"][0]
    # Owner-scoped: another learner sees none of it.
    stranger = capture.owner_for_token(capture.issue_identity())
    assert store.history(stranger) == [] and ObservationStore(capture).digest(stranger, [event["id"]]) == []


def test_history_is_capped_and_ascending(env):
    _, capture, owner, _, _ = env
    store = profile.ProfileStore(capture)
    prev, idx = None, {}
    for _ in range(22):
        sid = uuid4()
        capture.create_session(owner, sid)
        prev, idx = profile.reduce(prev, idx, [obs()], str(sid))
        store.write(owner, str(sid), lambda p, i, r=prev, x=idx: (r, x, {}))
    numbers = [r.revision for r in store.history(owner)]
    assert numbers == list(range(3, 23))
