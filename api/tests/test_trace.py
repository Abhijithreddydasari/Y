import json
from uuid import uuid4

from learning.trace import session_trace
from test_study_loop import (CHECK, FakeLabeler, FakeNotes, HintTutor, answer, events, settled,  # noqa: F401
                                   waiting)
from test_tutor_turn import env  # noqa: F401


def test_trace_lists_turns_hints_labels_and_close_without_secrets(env):
    client, capture, owner, sid, holder = env
    holder["labeler"] = FakeLabeler({"misconception": "none", "miss_class": "none"})
    holder["notes"] = FakeNotes()
    qid = waiting(client, sid, holder, CHECK)
    events(answer(client, sid, qid, choice="variance"))
    settled(client, sid)
    client.post(f"/learning/sessions/{sid}/close")
    got = client.get(f"/learning/sessions/{sid}/trace")
    assert got.status_code == 200
    value = got.json()
    first = value["turns"][0]
    assert first["stage"] == "turn" and first["kind"] == "question" and first["tutor"]["model"]
    assert "first_move_ms" in first["ms"] and "total_ms" in first["ms"] and first["model_call"]
    assert [t["kind"] for t in value["turns"]] == ["question", "answer"]
    label = value["labels"][0]
    assert label["qid"] == qid and label["stage"] == "label" and "label_ms" in label["ms"]
    assert value["close"]["stage"] == "close" and value["close"]["notes_model"].endswith("muse-spark-open-1026")
    text = json.dumps(value)
    assert CHECK["key"] not in text.replace('"variance"', "") and '"key"' not in text and "prompt" not in text


def test_trace_is_owner_scoped(env):
    client, capture, owner, sid, holder = env
    other = capture.issue_identity()
    client.cookies.set("y_learning_identity", other)
    assert client.get(f"/learning/sessions/{sid}/trace").status_code == 404


def test_hint_and_review_rows():
    turns = [{"seq": 1, "kind": "review", "status": "waiting", "moves": [{"type": "seg", "goal": "Warm-up"}],
              "timing": {"total_ms": 12.4}, "at": 1.0}]
    hints = [{"qid": "t.1", "level": 1, "at": 2.0, "ms": 2600, "usage": {"input_tokens": 300, "secret": 1},
              "tutor": {"option": "spark-1.3", "model": "muse-spark-1.3", "effort": "minimal"}}]
    value = session_trace(turns, hints, [], None, "m")
    assert value["turns"][0]["model_call"] is False and value["turns"][0]["ms"] == {"total_ms": 12}
    assert value["hints"][0]["ms"] == 2600 and value["hints"][0]["usage"] == {"input_tokens": 300}
    assert value["close"] is None
