import json
import pytest

from learning import tutor_models
from learning.tutor_moves import TurnValidator, diagram_error
from learning.tutor_provider import MetaTutor
from learning.tutor_storage import TutorStore
from test_tutor_turn import CHECK, SEG, WAIT, WRITE, FakeTutor, ask, doc, env, events  # noqa: F401

DIAGRAM = {"type": "diagram", "mermaid": "flowchart LR\n  Q[Query] --> S[Scores]\n  K[Key] --> S\n  S --> W[Softmax]"}
ATTENTION = {"type": "widget", "kind": "attention", "spec": json.dumps({"tokens": ["the", "cat", "sat"], "temp": 1})}
PLOT = {"type": "widget", "kind": "plot",
        "spec": json.dumps({"expr": "a*sin(x)", "x": [-3, 3], "params": {"a": {"min": 0, "max": 2, "value": 1}}})}


@pytest.mark.parametrize("source, ok", [
    ("flowchart LR\n A --> B", True),
    ("graph TD\n A[callback] --> B", True),
    ("sequenceDiagram\n Q->>K: dot product", True),
    ("%% a comment\nclassDiagram\n A <|-- B", True),
    ("pie\n \"a\": 1", False),
    ("", False),
    ("graph TD\n  click A call alert()", False),
    ("graph TD\n  A --> B\n  href A \"https://x\"", False),
    ("%%{init: {'theme': 'dark'}}%%\nflowchart LR\n A --> B", False),
    ("flowchart LR\n A[<img src=x>] --> B", False),
    ("flowchart LR\n" + "\n".join(f" N{i} --> N{i + 1}" for i in range(45)), False),
])
def test_diagram_precheck(source, ok):
    assert (diagram_error(source) is None) is ok


def test_diagram_and_widget_stream_to_the_board_once_each(env):
    client, capture, owner, sid, holder = env
    second = {**ATTENTION, "spec": json.dumps({"tokens": ["a", "b"], "temp": 2})}
    holder["tutor"] = FakeTutor([doc(SEG, DIAGRAM, ATTENTION, second, PLOT, CHECK, WAIT)])
    _, response = ask(client, sid)
    got = events(response)
    moves = [v["move"] for n, v in got if n == "move"]
    assert [m["type"] for m in moves] == ["seg", "diagram", "widget", "check", "turn_end"]
    assert moves[1]["mermaid"] == DIAGRAM["mermaid"] and json.loads(moves[2]["spec"])["tokens"] == ["the", "cat", "sat"]
    assert holder["tutor"].repair_calls == []  # one-per-turn errors are dropped, not repaired


def test_invalid_diagram_and_widget_spec_get_one_repair(env):
    client, capture, owner, sid, holder = env
    bad_diagram = {"type": "diagram", "mermaid": "pie\n \"a\": 1"}
    bad_plot = {**PLOT, "spec": json.dumps({"expr": "a*sin(x)", "x": [3, -3], "params": {}})}
    holder["tutor"] = FakeTutor([doc(SEG, bad_diagram, bad_plot, WRITE, {"type": "turn_end", "reason": "done"})],
                                repairs=[doc(DIAGRAM), doc(bad_plot)])
    _, response = ask(client, sid)
    moves = [v["move"]["type"] for n, v in events(response) if n == "move"]
    assert moves == ["seg", "diagram", "write", "turn_end"]
    assert len(holder["tutor"].repair_calls) == 2
    turn = TutorStore(capture).history(owner, str(sid))[-1]
    assert any("x range must ascend" in d for d in turn["timing"]["dropped"])


def test_unknown_model_is_rejected_before_any_claim_or_call(env):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, {"type": "turn_end", "reason": "done"})])
    for model, code in (("gpt-5", "tutor_model_unknown"), ("../etc", None), ("muse-spark-1.3", "tutor_model_unknown")):
        _, response = ask(client, sid, model=model)
        assert response.status_code == 422
        if code:
            assert response.json()["detail"] == code
    assert holder["tutor"].calls == [] and TutorStore(capture).history(owner, str(sid)) == []


def test_unconfigured_option_is_unavailable(env, monkeypatch):
    client, capture, owner, sid, holder = env
    monkeypatch.setenv("MODEL_API_KEY", "")
    holder["tutor"] = FakeTutor([])
    _, response = ask(client, sid, model="spark-1.2")
    assert response.status_code == 422 and response.json()["detail"] == "tutor_model_unavailable"
    assert TutorStore(capture).history(owner, str(sid)) == []


def test_chosen_model_is_used_and_recorded_in_the_trace(env, monkeypatch):
    client, capture, owner, sid, holder = env
    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, {"type": "turn_end", "reason": "done"})])
    _, response = ask(client, sid, model="spark-1.2")
    assert response.status_code == 200
    assert holder["tutor"].used[0].model == "muse-spark-1.2" and holder["tutor"].used[0].effort == "minimal"
    assert events(response)[-1][1]["tutor"]["model"] == "muse-spark-1.2"
    turn = TutorStore(capture).history(owner, str(sid))[-1]
    assert turn["timing"]["tutor"]["model"] == "muse-spark-1.2" and turn["input"]["model"] == "spark-1.2"
    state = client.get(f"/learning/sessions/{sid}/tutor").json()
    assert state["turns"][-1]["tutor"]["model"] == "muse-spark-1.2"


def test_meta_tutor_body_follows_the_option(monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "meta-key")
    monkeypatch.setenv("BASETEN_API_KEY", "")
    tutor = MetaTutor(client=None)
    body = tutor._body([], False, 10)
    assert body["model"] == "muse-spark-1.3" and body["reasoning_effort"] == "minimal"
    tutor.use(tutor_models.resolve("spark-1.3-low"))
    assert tutor._body([], False, 10)["reasoning_effort"] == "low" and tutor.base == tutor_models.META_BASE
    no_effort = tutor_models.TutorOption("x", "X", "", "baseten", "m", None)
    tutor.use(no_effort)
    assert "reasoning_effort" not in tutor._body([], False, 10) and tutor.base == tutor_models.BASETEN_BASE
    assert tutor.configured is False  # Baseten key not set


def test_options_report_availability_with_reasons(env, monkeypatch):
    client, *_ = env
    monkeypatch.setenv("MODEL_API_KEY", "")
    monkeypatch.setenv("BASETEN_API_KEY", "")
    value = client.get("/learning/tutor/options").json()
    assert [m["id"] for m in value["models"]][0] == "spark-1.3" and value["models"][0]["default"]
    assert all(not m["available"] and m["reason"] for m in value["models"])
    voices = {v["id"]: v for v in value["voices"]}
    assert voices["browser"]["available"] and voices["off"]["available"]
    assert {"browser", "off"} <= set(voices) and all(o["available"] for o in voices.values())  # never a dead control
    assert [v for v, o in voices.items() if o["default"]] == ["browser"]  # only Meta models unless a learner picks otherwise
    monkeypatch.setenv("MODEL_API_KEY", "k")
    models = {m["id"]: m["available"] for m in client.get("/learning/tutor/options").json()["models"]}
    assert models == {"spark-1.3": True, "spark-1.3-low": True, "spark-1.2": True, "spark-open": False}


def test_options_need_an_identity(env):
    client, *_ = env
    client.cookies.clear()
    assert client.get("/learning/tutor/options").status_code == 401


@pytest.mark.parametrize("expr, params, ok", [
    ("a*sin(b*x)", {"a": 1, "b": 1}, True),
    ("2x + 1e-3 + pi", {}, True),
    ("k*x", {}, False),
    ("x2", {}, False),
    ("x", {"x": 1}, False),
])
def test_plot_names_match_the_browser_evaluator(expr, params, ok):
    spec = {"expr": expr, "x": [0, 1], "params": {n: {"min": 0, "max": 2, "value": v} for n, v in params.items()}}
    move = {**PLOT, "spec": json.dumps(spec)}
    if ok:
        TurnValidator().accept(move)
    else:
        with pytest.raises(Exception):
            TurnValidator().accept(move)


def test_validator_accepts_both_widget_kinds():
    validator = TurnValidator()
    for move in (ATTENTION, PLOT, DIAGRAM):
        validator.accept(move)
    with pytest.raises(Exception):
        TurnValidator().accept({**PLOT, "spec": json.dumps({"expr": "__import__('os')", "x": [0, 1], "params": {}})})


def test_turn_id_with_a_different_model_is_a_conflict(env, monkeypatch):
    client, capture, owner, sid, holder = env
    monkeypatch.setenv("MODEL_API_KEY", "k")
    holder["tutor"] = FakeTutor([doc(SEG, WRITE, {"type": "turn_end", "reason": "done"})])
    body, first = ask(client, sid)
    assert first.status_code == 200
    again = client.post(f"/learning/sessions/{sid}/tutor/turns", json={**body, "model": "spark-1.2"})
    assert again.status_code == 409


def test_plot_spec_names_its_axes_within_bounds():
    from learning.tutor_moves import PlotSpec

    base = {"expr": "a*x", "x": [0, 1], "params": {"a": {"min": 0, "max": 1, "value": 0.5}}}
    assert PlotSpec.model_validate({**base, "xLabel": "time (s)", "yLabel": "height (m)"}).xLabel == "time (s)"
    assert PlotSpec.model_validate(base).yLabel == ""  # earlier graphs carry no names
    with pytest.raises(ValueError):
        PlotSpec.model_validate({**base, "xLabel": "x" * 41})


def test_an_optional_voice_that_cannot_speak_is_left_out(monkeypatch):
    from types import SimpleNamespace
    from learning.tutor_models import voice_options
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    assert [v["id"] for v in voice_options(None)] == ["browser", "off"]
    assert [v["id"] for v in voice_options(SimpleNamespace(available=False))] == ["browser", "off"]
    ready = voice_options(SimpleNamespace(available=True))
    assert {"kokoro_af_heart", "kokoro_am_michael"} < {v["id"] for v in ready} and all(v["available"] for v in ready)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "d")
    assert "Thalia" in [v["label"] for v in voice_options(None)]
