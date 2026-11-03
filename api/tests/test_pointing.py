from io import BytesIO
from uuid import uuid4

from PIL import Image

from learning.board_contracts import Edit, EditBatch, Element
from learning.board_storage import BoardStore
from learning.pointing import ink_lines, resolve
from learning.tutor_provider import MetaTutor
from learning.tutor_storage import TutorStore
from test_tutor_turn import CHECK, DONE, SEG, WAIT, WRITE, FakeTutor, ask, doc, env, events  # noqa: F401


def box(x, y, w, h, id=None):
    return {"x": x, "y": y, "w": w, "h": h}


def ink(boxes):
    return [{"id": f"s{i}", "bounds": b, "creator": "human", "visual": True} for i, b in enumerate(boxes)]


# Three handwritten lines, ~40 px letters, slightly slanted; "=" is two flat strokes, "-" one.
LINE1 = [box(100, 100, 30, 40), box(140, 104, 28, 36), box(185, 118, 20, 3), box(215, 112, 20, 3), box(215, 122, 20, 3),
         box(250, 102, 50, 40)]
LINE2 = [box(102, 180, 30, 42), box(140, 185, 28, 36), box(190, 196, 22, 3), box(190, 206, 22, 3), box(225, 183, 52, 40)]
LINE3 = [box(104, 262, 28, 38), box(150, 274, 22, 3), box(150, 284, 22, 3), box(185, 260, 60, 42)]
CROP = {"bounds": {"x": 76, "y": 76, "w": 248, "h": 250}, "element_ids": [f"s{i}" for i in range(14)]}


def test_strokes_group_into_lines_top_to_bottom_with_flat_strokes_kept():
    lines = ink_lines(LINE3 + LINE1 + LINE2)
    assert [len(line) for line in lines] == [6, 5, 4]


def test_reported_line_wins_over_a_raw_point_that_skews_down():
    # The model says line 2 but its point sits on line 3 (the measured downward skew).
    move = {"x": 500, "y": 780, "line": 2, "label": "20 - 5 is 15"}
    placed = resolve(move, CROP, ink(LINE1 + LINE2 + LINE3))
    assert placed["snap"] == "line" and placed["lines"] == 3
    at = placed["at"]
    assert at["y"] <= 180 and at["y"] + at["h"] >= 223 and at["y"] > 142 and at["y"] + at["h"] < 262
    assert at["x"] <= 102 and at["x"] + at["w"] >= 277
    assert placed["raw"]["y"] > 262  # the raw point alone would have ringed line 3


def test_unknown_line_uses_the_line_under_the_point():
    placed = resolve({"x": 300, "y": 496, "line": 0, "label": "x"}, CROP, ink(LINE1 + LINE2 + LINE3))
    assert placed["snap"] == "nearest" and placed["raw"]["y"] == 200.0
    assert 142 < placed["at"]["y"] <= 180


def test_out_of_range_line_falls_back_to_nearest_and_tutor_ink_is_ignored():
    strokes = ink(LINE1 + LINE2)
    strokes.append({"id": "s99", "bounds": box(100, 400, 200, 40), "creator": "model", "visual": True})
    crop = {**CROP, "element_ids": CROP["element_ids"] + ["s99"]}
    placed = resolve({"x": 500, "y": 450, "line": 7, "label": "x"}, crop, strokes)
    assert placed["snap"] == "nearest" and placed["lines"] == 2


def test_a_wide_gap_separates_two_pieces_of_work_on_one_row():
    left = [box(100, 100, 30, 40), box(140, 100, 30, 40)]
    right = [box(600, 100, 30, 40), box(640, 100, 30, 40)]
    crop = {"bounds": {"x": 76, "y": 76, "w": 618, "h": 88}, "element_ids": ["s0", "s1", "s2", "s3"]}
    placed = resolve({"x": 900, "y": 500, "line": 1, "label": "x"}, crop, ink(left + right))
    assert placed["at"]["x"] >= 580


def test_no_learner_ink_gives_a_small_ring_at_the_raw_point():
    placed = resolve({"x": 500, "y": 500, "line": 1, "label": "x"}, CROP, [])
    assert placed["snap"] == "raw" and placed["at"]["w"] == 60
    assert placed["raw"] == {"x": 200.0, "y": 201.0}


def test_point_is_only_in_the_schema_when_an_image_is_attached():
    tutor = MetaTutor(client=None, api_key="k")
    text_only = [{"role": "user", "content": [{"type": "text", "text": "x"}]}]
    with_ink = [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:"}}]}]

    def kinds(messages):
        variants = tutor._body(messages, True, 10)["response_format"]["json_schema"]["schema"]["properties"]["moves"]["items"]["anyOf"]
        return {v["properties"]["type"]["enum"][0] for v in variants}
    assert "point" not in kinds(text_only) and "point" in kinds(with_ink)


def _png(w, h):
    out = BytesIO()
    Image.new("RGB", (w, h), "white").save(out, format="PNG")
    return out.getvalue()


def test_point_on_an_ink_crop_is_resolved_stored_and_replayed(env):
    client, capture, owner, sid, holder = env
    boards = BoardStore(capture)
    strokes = LINE1 + LINE2 + LINE3
    edits = [Edit(element=Element(id=f"s{i}", type="freedraw", x=b["x"], y=b["y"], width=b["w"], height=b["h"],
                                  points=[[0, 0], [b["w"], b["h"]]]), actor="human") for i, b in enumerate(strokes)]
    boards.apply(owner, sid, EditBatch(operation_id=uuid4(), expected_revision=0, edits=edits))
    asset = boards.put_asset(owner, sid, _png(496, 500))["hash"]
    crop = {"asset_hash": asset, "bounds": CROP["bounds"], "element_ids": CROP["element_ids"], "purpose": "initial"}
    board = {"request_id": str(uuid4()), "revision": 1, "viewport": {"x": 0, "y": 0, "w": 1400, "h": 1000}, "crops": [crop]}
    point = {"type": "point", "crop": 0, "x": 500, "y": 780, "line": 2, "label": "20 - 5 is 15"}
    second = {**point, "line": 1}
    holder["tutor"] = FakeTutor([doc(SEG, point, second, point, WRITE, DONE)])
    body, response = ask(client, sid, "Is my working right?", board=board)
    got = events(response)
    moves = [v["move"] for n, v in got if n == "move"]
    assert [m["type"] for m in moves] == ["seg", "point", "point", "write", "turn_end"]  # third point dropped
    assert moves[1]["snap"] == "line" and 142 < moves[1]["at"]["y"] <= 180
    assert holder["tutor"].repair_calls == []
    stored = TutorStore(capture).history(owner, str(sid))[-1]
    assert stored["moves"][1]["at"] == moves[1]["at"]
    assert stored["timing"]["points"] == [{"snap": "line", "line": 2, "lines": 3}, {"snap": "line", "line": 1, "lines": 3}]
    replay = events(client.post(f"/learning/sessions/{sid}/tutor/turns", json=body))
    assert [v["move"] for n, v in replay if n == "move"][1]["at"] == moves[1]["at"]
    assert len(holder["tutor"].calls) == 1
