"""Learner ink crops as image evidence for the labeler (mocked)."""
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image

from learning import observations
from learning.board_contracts import ContextInput, Crop, Rect
from learning.board_storage import BoardStore
from learning.tutor_router import ink_crops
from learning.tutor_turn import TurnInput
from test_evidence import FakeLabeler, _scene, settled  # noqa: F401
from test_tutor_turn import env, events  # noqa: F401


@pytest.fixture(autouse=True)
def one_loop(env):
    with env[0]:
        yield


def png(color="white"):
    out = BytesIO()
    Image.new("RGB", (40, 30), color).save(out, format="PNG")
    return out.getvalue()


def _crop(key, ids):
    return Crop(asset_hash=key, bounds=Rect(x=0, y=0, w=10, h=10), element_ids=ids)


def test_only_crops_made_of_the_answers_own_ink_are_kept():
    board = ContextInput(request_id=uuid4(), revision=1, crops=[
        _crop("a" * 64, ["my-ink"]), _crop("b" * 64, ["my-ink", "tutor-ink"]), _crop("c" * 64, ["my-ink", "more"]),
        _crop("d" * 64, ["more"])])
    body = TurnInput(turn_id=uuid4(), kind="answer", question_id="q", text="x", via="ink",
                     element_ids=("my-ink", "more"), board=board)
    assert ink_crops(body) == ("a" * 64, "c" * 64)  # mixed with tutor ink: never sent; at most two
    typed = TurnInput(turn_id=uuid4(), kind="answer", question_id="q", text="x", board=board)
    assert ink_crops(typed) == ()


def test_ink_answer_sends_its_stored_crops_to_the_labeler(env):
    client_, capture, owner, sid, holder = env
    holder["labeler"] = labeler = FakeLabeler({"outcome": "correct"})
    labeler.provider_name = "meta"
    boards = BoardStore(capture)
    boards.load(owner, sid)
    _scene(capture, owner, sid, "human", "my-ink")
    asset = boards.put_asset(owner, str(sid), png("black"))
    row, created = observations.ObservationStore(capture).capture_answer(
        owner, str(sid), str(uuid4()), {"qid": "t.9", "kind": "free", "q": "Sketch it", "key": "a parabola", "options": [],
                                        "concept": "curves", "dim": "apply"},
        "parabola", {"result": "unverified", "verified": None}, "ink", [], ("my-ink",), (asset["hash"], "e" * 64))
    store = observations.ObservationStore(capture)
    client_.portal.call(observations.label, store, labeler, owner, row["observation_id"])
    [stored] = settled(client_, sid)
    assert len(labeler.images) == 1 and labeler.images[0][0] == "image/png"  # the missing asset is skipped
    assert stored["observation"]["labeler"] == "meta" and stored["fields"]["outcome"]["source"] == "meta"
