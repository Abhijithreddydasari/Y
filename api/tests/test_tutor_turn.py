import asyncio
import json
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from learning.board_contracts import Edit, EditBatch, Element
from learning.board_router import router as board_router
from learning.board_storage import BoardStore
from learning.decisions import ProviderFailure
from learning.router import COOKIE, get_store, router
from learning.storage import CaptureStore, make_engine
from learning.tutor_moves import TurnValidator
from learning.tutor_router import get_tutor, router as tutor_router
from learning.tutor_storage import TutorStore, open_question
from learning.tutor_turn import (MEMORY_BUDGET, SYSTEM_PREFIX, TurnInput, TurnRun, build_messages, grade,
                                 public_move, session_memory)


class FakeTutor:
    """Scripted provider: yields the document in small chunks, records every call."""

    def __init__(self, documents, repairs=(), chunk=7, fail=None):
        self.documents, self.repairs, self.chunk, self.fail = list(documents), list(repairs), chunk, fail
        self.calls, self.repair_calls, self.closed = [], [], False
        self.configured, self.model = True, "fake"
        self.usage, self.timing, self.used = {}, {}, []

    def use(self, option):
        self.used.append(option)
        self.model = option.model

    @property
    def trace(self):
        return {"option": "fake", "model": self.model, "effort": "minimal"}

    async def stream(self, messages):
        self.calls.append(messages)
        text = self.documents.pop(0)
        try:
            for start in range(0, len(text), self.chunk):
                await asyncio.sleep(0)
                yield text[start:start + self.chunk]
            if self.fail:
                raise ProviderFailure(self.fail)
        finally:
            self.closed = True

    async def complete(self, messages):
        self.repair_calls.append(messages)
        return self.repairs.pop(0)


def doc(*moves):
    return json.dumps({"moves": list(moves)})


SEG = {"type": "seg", "id": "s1", "goal": "Why scale by root d"}
WRITE = {"type": "write", "text": "Dot products grow with dimension."}
EQ = {"type": "equation", "latex": "\\frac{q \\cdot k}{\\sqrt{d_k}}"}
CHECK = {"type": "check", "kind": "mcq", "q": "What grows with d_k?", "key": "variance",
         "concept": "attention.scaling", "dim": "understand", "options": ["variance", "the mean", "nothing"]}
WAIT = {"type": "turn_end", "reason": "wait"}
DONE = {"type": "turn_end", "reason": "done"}


@pytest.fixture
def env(tmp_path):
    capture = CaptureStore(make_engine(f"sqlite:///{(tmp_path / 'tutor.db').as_posix()}"))
    capture.initialize()
    token = capture.issue_identity()
    owner = capture.owner_for_token(token)
    sid = uuid4()
    capture.create_session(owner, sid)
    app = FastAPI()
    app.include_router(router)
    app.include_router(board_router)
    app.include_router(tutor_router)
    app.dependency_overrides[get_store] = lambda: capture
    holder = {}
    app.dependency_overrides[get_tutor] = lambda: holder["tutor"]
    client = TestClient(app)
    client.cookies.set(COOKIE, token)
    yield client, capture, owner, sid, holder
    capture.engine.dispose()


def events(response):
    out = []
    for frame in response.text.replace("\r\n", "\n").split("\n\n"):
        name = next((line[6:].strip() for line in frame.split("\n") if line.startswith("event:")), None)
        data = "\n".join(line[5:].strip() for line in frame.split("\n") if line.startswith("data:"))
        if name:
            out.append((name, json.loads(data)))
    return out


def ask(client, sid, text="Why divide by root d_k?", **extra):
    body = {"turn_id": str(uuid4()), "kind": "question", "text": text, **extra}
    return body, client.post(f"/learning/sessions/{sid}/tutor/turns", json=body)


def test_question_streams_moves_in_order_and_waits_without_leaking_the_key(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, EQ, CHECK, WAIT)])
    body, response = ask(client, sid)
    got = events(response)
    names = [name for name, _ in got]
    assert names == ["turn", "move", "move", "move", "move", "move", "done"]
    moves = [value["move"] for name, value in got if name == "move"]
    assert [m["type"] for m in moves] == ["seg", "write", "equation", "check", "turn_end"]
    assert moves[2]["latex"] == EQ["latex"]
    card = moves[3]
    assert card == {"type": "check", "kind": "mcq", "q": CHECK["q"], "options": CHECK["options"], "qid": f"{body['turn_id']}.3"}
    assert "key" not in json.dumps(got)
    done = got[-1][1]
    assert done["status"] == "waiting" and done["question"]["qid"] == card["qid"]
    assert "first_move_ms" in done["timing"]
    state = client.get(f"/learning/sessions/{sid}/tutor").json()
    assert state["open"] == {"qid": card["qid"], "kind": "mcq", "q": CHECK["q"], "options": CHECK["options"]}
    assert state["turns"][0]["status"] == "waiting" and state["turns"][0]["goals"] == [SEG["goal"]]


def test_packet_order_and_cache_friendly_prefix(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, DONE), doc(WRITE, DONE)])
    ask(client, sid, "first")
    ask(client, sid, "second")
    first, second = holder["tutor"].calls
    assert first[0] == second[0] == {"role": "system", "content": SYSTEM_PREFIX}
    labels = [part["text"].split("\n", 1)[0] for part in second[1]["content"]]
    assert labels == ["LEARNER BRIEF", "SESSION MEMORY", "BOARD FOCUS", "THIS TURN"]
    memory = json.loads(second[1]["content"][1]["text"].split("\n", 1)[1])
    assert memory["lesson_map"] == [SEG["goal"]]
    assert memory["recent_turns"][0]["learner"] == {"asked": "first"}
    assert memory["recent_turns"][0]["tutor"][1] == WRITE
    assert json.loads(second[1]["content"][3]["text"].split("\n", 1)[1]) == {"kind": "question", "text": "second"}


def test_native_board_text_reaches_the_model_verbatim(env):
    client, capture, owner, sid, holder = env
    boards = BoardStore(capture)
    work = Element(id="work", type="text", x=100, y=100, width=200, height=40, text="3x + 5 = 20\nx = 4")
    tutor_note = Element(id="old", type="text", x=600, y=100, width=200, height=40, text="earlier tutor text")
    boards.apply(owner, sid, EditBatch(operation_id=uuid4(), expected_revision=0,
        edits=[Edit(element=work, actor="human"), Edit(element=tutor_note, actor="model", source_revision=0)]))
    holder["tutor"] = FakeTutor([doc(WRITE, DONE)])
    board = {"request_id": str(uuid4()), "revision": 1, "viewport": {"x": 0, "y": 0, "w": 1400, "h": 1000}}
    ask(client, sid, "Is my step right?", board=board)
    focus = json.loads(holder["tutor"].calls[0][1]["content"][2]["text"].split("\n", 1)[1])
    assert [f["text"] for f in focus["focused"]] == ["3x + 5 = 20\nx = 4"]
    assert "question" not in focus


def test_invalid_move_is_repaired_once_and_otherwise_dropped(env):
    client, capture, owner, sid, holder = env
    bad = {**CHECK, "key": "the variance"}
    fixed = doc(CHECK)
    holder["tutor"] = FakeTutor([doc(SEG, bad, WAIT)], repairs=[fixed])
    _, response = ask(client, sid)
    moves = [v["move"]["type"] for n, v in events(response) if n == "move"]
    assert moves == ["seg", "check", "turn_end"]
    assert "mcq key is not one of its options" in holder["tutor"].repair_calls[0][1]["content"]

    holder["tutor"] = FakeTutor([doc(SEG, bad, WRITE, DONE)], repairs=[doc(bad)])
    _, response = ask(client, sid)
    got = events(response)
    assert [v["move"]["type"] for n, v in got if n == "move"] == ["seg", "write", "turn_end"]
    assert got[-1][1]["status"] == "done"
    turn = TutorStore(capture).history(owner, str(sid))[-1]
    assert turn["timing"]["repairs"] == 1 and "repair failed" in turn["timing"]["dropped"][0]


def test_disabled_kinds_and_moves_after_the_question_never_render(env):
    client, capture, owner, sid, holder = env
    point = {"type": "point", "crop": 0, "x": 10, "y": 10, "line": 1, "label": "here"}
    holder["tutor"] = FakeTutor([doc(SEG, point, CHECK, WRITE, WAIT)])
    _, response = ask(client, sid)
    got = events(response)
    assert [v["move"]["type"] for n, v in got if n == "move"] == ["seg", "check", "turn_end"]
    assert holder["tutor"].repair_calls == []
    assert got[-1][1]["status"] == "waiting"


def test_answer_resumes_the_waiting_turn_with_a_graded_result(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, CHECK, WAIT), doc(WRITE, DONE), doc(WRITE, DONE)])
    first, response = ask(client, sid)
    qid = events(response)[-1][1]["question"]["qid"]
    wrong = client.post(f"/learning/sessions/{sid}/tutor/turns",
                        json={"turn_id": str(uuid4()), "kind": "answer", "question_id": "nope", "choice": "variance"})
    assert wrong.status_code == 409 and wrong.json()["detail"] == "tutor_question_not_open"
    answer = client.post(f"/learning/sessions/{sid}/tutor/turns",
                         json={"turn_id": str(uuid4()), "kind": "answer", "question_id": qid, "choice": "the mean", "confidence": 80})
    got = events(answer)
    assert got[0][1]["outcome"] == {"qid": qid, "result": "incorrect"}
    turn = json.loads(holder["tutor"].calls[1][1]["content"][3]["text"].split("\n", 1)[1])
    assert turn == {"kind": "answer", "question": {"kind": "mcq", "q": CHECK["q"], "options": CHECK["options"], "key": "variance"},
                    "learner_answer": "the mean", "confidence": 80, "result": "incorrect"}
    assert got[-1][1]["status"] == "done"
    assert client.get(f"/learning/sessions/{sid}/tutor").json()["open"] is None
    again = client.post(f"/learning/sessions/{sid}/tutor/turns",
                        json={"turn_id": str(uuid4()), "kind": "answer", "question_id": qid, "choice": "variance"})
    assert again.status_code == 409


def test_grading_rules():
    question = {"qid": "t.1", "kind": "mcq", "q": "q", "options": ["a", "b"], "key": "a", "concept": "c", "dim": "apply"}
    turn = lambda **kw: TurnInput(turn_id=uuid4(), kind="answer", question_id="t.1", **kw)
    assert grade(question, turn(choice="a"))["result"] == "correct"
    assert grade(question, turn(choice="b"))["result"] == "incorrect"
    assert grade(question, turn(reveal=True))["result"] == "revealed"
    free = {**question, "kind": "free", "options": [], "key": "Variance"}
    assert grade(free, turn(text=" variance "))["result"] == "correct"
    assert grade(free, turn(text="it spreads out"))["result"] == "unverified"
    with pytest.raises(ValueError):
        TurnInput(turn_id=uuid4(), kind="answer", question_id="t.1")
    with pytest.raises(ValueError):
        TurnInput(turn_id=uuid4(), kind="question", text="  ")


def test_repeated_turn_id_replays_without_a_second_paid_call(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, CHECK, WAIT)])
    body, first = ask(client, sid)
    again = client.post(f"/learning/sessions/{sid}/tutor/turns", json=body)
    assert len(holder["tutor"].calls) == 1
    replayed = events(again)
    assert [v["move"]["type"] for n, v in replayed if n == "move"] == ["seg", "check", "turn_end"]
    assert replayed[-1][1]["replayed"] and replayed[-1][1]["question"]["qid"] == f"{body['turn_id']}.1"
    reused = client.post(f"/learning/sessions/{sid}/tutor/turns", json={**body, "text": "different"})
    assert reused.status_code == 409 and reused.json()["detail"] == "tutor_turn_reused"


def test_missing_key_is_an_honest_configuration_error(env):
    client, capture, owner, sid, holder = env
    tutor = FakeTutor([])
    tutor.configured = False
    holder["tutor"] = tutor
    _, response = ask(client, sid)
    assert response.status_code == 503 and response.json()["detail"] == "tutor_not_configured"
    assert client.get(f"/learning/sessions/{sid}/tutor").json()["configured"] is False
    assert TutorStore(capture).history(owner, str(sid)) == []


def test_truncated_turn_keeps_completed_moves_and_ends_with_a_recoverable_message(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, DONE)[:-30]])
    _, response = ask(client, sid)
    got = events(response)
    assert [v["move"]["type"] for n, v in got if n == "move"] == ["seg", "write"]
    error = next(v for n, v in got if n == "error")
    assert error["status"] == "incomplete" and "ask again" in error["message"]
    holder["tutor"] = FakeTutor([doc(SEG, WRITE)], fail="provider_timeout")
    holder["tutor"].documents = ['{"moves": [']
    _, response = ask(client, sid)
    got = events(response)
    assert got[-2][1]["code"] == "provider_timeout" and got[-1][1]["status"] == "failed"
    statuses = [t["status"] for t in TutorStore(capture).history(owner, str(sid))]
    assert statuses == ["incomplete", "failed"]


def test_one_turn_streams_per_session(env):
    client, capture, owner, sid, holder = env
    store = TutorStore(capture)
    assert store.begin(owner, str(sid), str(uuid4()), "question", {}, "h") is None
    holder["tutor"] = FakeTutor([doc(WRITE, DONE)])
    _, response = ask(client, sid)
    assert response.status_code == 409 and response.json()["detail"] == "tutor_turn_in_progress"


def test_stop_cancels_the_provider_and_keeps_completed_moves():
    async def scenario():
        tutor = FakeTutor([doc(SEG, WRITE, EQ, DONE)], chunk=5)
        run = TurnRun(tutor, [], TurnValidator())
        stream = run.events()
        first = await anext(stream)
        await stream.aclose()
        await asyncio.sleep(0)
        return first, run, tutor
    first, run, tutor = asyncio.run(scenario())
    assert first == (0, SEG) and run.moves == [SEG] and tutor.closed


def test_session_memory_is_bounded_and_keeps_recent_turns_verbatim():
    big = [{"type": "write", "text": "x" * 390}] * 10
    history = [{"seq": i, "kind": "question", "status": "done", "input": {"text": f"q{i}"}, "question": None,
                "outcome": None, "moves": [{"type": "seg", "id": "s1", "goal": f"goal {i}"}, *big]} for i in range(30)]
    memory = session_memory(history)
    assert len(json.dumps(memory, separators=(",", ":"))) <= MEMORY_BUDGET
    assert memory["recent_turns"][-1]["learner"] == {"asked": "q29"}
    assert memory["lesson_map"][-1] == "goal 29" and len(memory["lesson_map"]) == 24
    assert session_memory([{**history[0], "status": "failed"}]) == {"lesson_map": [], "older_turns": [], "recent_turns": []}


def test_open_question_closes_on_any_later_turn():
    waiting = {"status": "waiting", "question": {"qid": "a.1"}, "moves": [{"type": "check"}]}
    assert open_question([waiting]) == {"qid": "a.1"}
    assert open_question([waiting, {"status": "failed", "question": None, "moves": []}]) == {"qid": "a.1"}
    assert open_question([waiting, {"status": "stopped", "question": None, "moves": []}]) == {"qid": "a.1"}
    assert open_question([waiting, {"status": "stopped", "question": None, "moves": [{"type": "write"}]}]) is None
    assert open_question([waiting, {"status": "done", "question": None, "moves": [{"type": "write"}]}]) is None


def test_messages_carry_crops_as_images_between_board_and_turn():
    messages = build_messages("", {}, {"focused": []}, {"kind": "question", "text": "hi"}, [("image/png", b"\x89PNG")])
    kinds = [part["type"] for part in messages[1]["content"]]
    assert kinds == ["text", "text", "text", "image_url", "text"]
    assert messages[1]["content"][3]["image_url"]["url"].startswith("data:image/png;base64,")


def test_public_move_hides_answers():
    predict = {"type": "predict", "q": "Guess", "options": ["up", "down"], "answer": "up"}
    assert public_move(predict, "t.0") == {"type": "predict", "kind": "mcq", "q": "Guess", "options": ["up", "down"], "qid": "t.0"}


def test_live_schema_only_offers_renderable_kinds():
    from learning.tutor_moves import response_format
    from learning.tutor_turn import ENABLED
    variants = response_format(ENABLED)["json_schema"]["schema"]["properties"]["moves"]["items"]["anyOf"]
    assert {v["properties"]["type"]["enum"][0] for v in variants} == ENABLED
    assert len(response_format()["json_schema"]["schema"]["properties"]["moves"]["items"]["anyOf"]) == 12
