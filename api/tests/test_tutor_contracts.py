import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from learning.learner_contracts import (Belief, ConstellationGraph, LearnerBrief, Observation,
                                        ProfileRevision)
from learning.tutor_moves import (MOVE_KINDS, MOVE_MODELS, SCHEMA_PATH, MoveError, TurnValidator,
                                  move_schema, response_format, restore_latex, validate_turn)
from learning.tutor_stream import MoveStreamParser, MoveSyntaxError

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "fixtures"
                      / "attention-arc.v1.json").read_text(encoding="utf-8"))
BRIEF = LearnerBrief.model_validate(FIXTURE["brief"])
TURN = FIXTURE["turn"]["moves"]
END = {"type": "turn_end", "reason": "done"}
WAIT = {"type": "turn_end", "reason": "wait"}
MCQ = {"type": "check", "kind": "mcq", "q": "Which?", "key": "b", "concept": "softmax", "dim": "apply",
       "options": ["a", "b", "c"]}


def widget(kind, spec):
    return {"type": "widget", "kind": kind, "spec": spec if isinstance(spec, str) else json.dumps(spec)}


# ---------- strict schema ----------

def walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def test_schema_satisfies_meta_strict_mode():
    schema = move_schema()
    objects = [n for n in walk(schema) if n.get("type") == "object"]
    assert len(objects) == len(MOVE_KINDS) + 1
    for obj in objects:
        assert obj["additionalProperties"] is False
        assert obj["required"] == list(obj["properties"])
    for node in walk(schema):
        assert not {"$ref", "$defs", "const", "default", "title"} & node.keys()


def test_schema_variants_match_models_and_kinds():
    variants = move_schema()["properties"]["moves"]["items"]["anyOf"]
    assert [v["properties"]["type"]["enum"] for v in variants] == [[k] for k in MOVE_KINDS]
    for variant, model in zip(variants, MOVE_MODELS):
        assert list(variant["properties"]) == list(model.model_fields)
    by_kind = {v["properties"]["type"]["enum"][0]: v["properties"] for v in variants}
    assert by_kind["widget"]["spec"] == {"type": "string", "description": "JSON-encoded spec object"}
    assert by_kind["widget"]["kind"]["enum"] == ["plot", "attention", "matrix", "stepper"]
    assert by_kind["predict"]["options"] == {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4}
    assert by_kind["check"]["dim"]["enum"] == ["recall", "understand", "apply", "analyze", "transfer"]
    assert by_kind["point"]["x"]["type"] == "integer"


def test_checked_in_schema_is_current():
    # Regenerate from api: .venv\Scripts\python.exe -m learning.tutor_moves
    assert json.loads(SCHEMA_PATH.read_text(encoding="utf-8")) == move_schema()
    assert response_format()["json_schema"]["strict"] is True


# ---------- semantic validator ----------

def test_fixture_turn_is_valid_with_its_brief():
    moves, errors = validate_turn(FIXTURE["turn"], BRIEF.refs)
    assert errors == [] and len(moves) == len(TURN)


def test_because_requires_brief_refs():
    moves, errors = validate_turn(FIXTURE["turn"])
    assert sum("not in the brief" in e for e in errors) == 2
    assert len(moves) == len(TURN) - 2


@pytest.mark.parametrize("move, message", [
    ({"type": "predict", "q": "?", "options": ["a", "b"], "answer": "c"}, "answer is not one of"),
    ({"type": "predict", "q": "?", "options": ["a", "a"], "answer": "a"}, "options repeat"),
    ({**MCQ, "key": "z"}, "key is not one of"),
    ({**MCQ, "options": ["b"]}, "2-5 distinct"),
    ({**MCQ, "kind": "free"}, "takes no options"),
    ({"type": "because", "refs": ["M9"], "text": "x"}, "M9"),
    ({"type": "point", "crop": 0, "x": 1, "y": 1, "line": 2, "label": "here"}, "crop that was not sent"),
    ({"type": "poem", "text": "x"}, "type"),
    ({"type": "write", "text": "x", "extra": 1}, "extra"),
    ({"type": "write", "text": ""}, "text"),
    (widget("chart", {}), "kind"),
    (widget("plot", "{not json"), "not valid JSON"),
    (widget("plot", "[1, 2]"), "JSON object"),
    (widget("plot", {"expr": "__import__('os')", "x": [0, 1], "params": {}}), "plot spec expr"),
    (widget("plot", {"expr": "a*x", "x": [1, 0], "params": {}}), "x range"),
    (widget("plot", {"expr": "a*x", "x": [0, 1], "params": {"a": {"min": 0, "max": 1, "value": 2}}}), "min <= value"),
    (widget("attention", {"tokens": ["a", "b"], "temp": 1, "scores": [[1, 0], [0, 1]]}), "scores"),
    (widget("attention", {"tokens": ["a"], "temp": 1}), "tokens"),
    (widget("matrix", {"m": [[1, 2], [3]]}), "rectangular"),
    (widget("stepper", {"steps": ["x"]}), "steps"),
])
def test_invalid_moves_are_rejected(move, message):
    with pytest.raises(MoveError, match=message):
        TurnValidator(frozenset({"M3"})).accept(move)


def test_valid_widget_specs():
    v = TurnValidator()
    v.accept(widget("plot", {"expr": "a*sin(b*x)", "x": [-6.28, 6.28],
                             "params": {"a": {"min": 0.1, "max": 3, "value": 1}, "b": {"min": 0.5, "max": 4, "value": 1}}}))
    v.accept(widget("matrix", {"m": [[2, 1], [0, 1]]}))
    v.accept(widget("stepper", {"steps": ["\x0crac{a}{b}", "\\frac{a}{b}"]}))
    v.accept(widget("attention", {"tokens": ["the", "cat"], "temp": 0.5}))


def test_turn_rules():
    v = TurnValidator()
    with pytest.raises(MoveError, match="wait requires"):
        v.accept(WAIT)
    v.accept(MCQ)
    with pytest.raises(MoveError, match="only one check"):
        v.accept(MCQ)
    with pytest.raises(MoveError, match="must end with wait"):
        v.accept(END)
    with pytest.raises(MoveError, match="did not end"):
        v.finish()
    v.accept(WAIT)
    v.finish()
    with pytest.raises(MoveError, match="after turn_end"):
        v.accept({"type": "say", "text": "late"})


def test_rejected_move_leaves_state_unchanged():
    v = TurnValidator()
    with pytest.raises(MoveError):
        v.accept({**MCQ, "key": "z"})
    v.accept(MCQ)  # the repaired check is still the first check
    v.accept({"type": "seg", "id": "s1", "goal": "g"})
    with pytest.raises(MoveError, match="duplicate segment"):
        v.accept({"type": "seg", "id": "s1", "goal": "g"})
    assert v.count == 2


def test_turn_length_is_bounded():
    v = TurnValidator()
    for _ in range(40):
        v.accept({"type": "say", "text": "x"})
    with pytest.raises(MoveError, match="exceeds 40"):
        v.accept(END)


def test_restore_latex_undoes_lost_escapes_only():
    assert restore_latex("\x0crac{1}{\\sqrt{d}} \x09heta \x08eta \nabla \rho") == "\\frac{1}{\\sqrt{d}} \\theta \\beta \\nabla \\rho"
    assert restore_latex("a = 1\nb = 2") == "a = 1\nb = 2"
    assert TurnValidator().accept({"type": "equation", "latex": "\x0crac{a}{b}"}).latex == "\\frac{a}{b}"


# ---------- incremental stream parser ----------

def chunks(text, size):
    return [text[i:i + size] for i in range(0, len(text), size)]


def parse(parts):
    parser, out = MoveStreamParser(), []
    for part in parts:
        out.extend(parser.feed(part))
    parser.close()
    return out


@pytest.mark.parametrize("size", [1, 2, 3, 7, 64, 100_000])
def test_parser_matches_json_for_any_chunking(size):
    text = json.dumps(FIXTURE["turn"], indent=1)
    elements = parse(chunks(text, size))
    assert [e.value for e in elements] == TURN
    assert [e.index for e in elements] == list(range(len(TURN)))
    assert all(json.loads(e.raw) == e.value for e in elements)


def test_each_move_is_emitted_when_its_object_closes():
    text = json.dumps({"moves": TURN[:3]})
    first_end = text.index(json.dumps(TURN[0])) + len(json.dumps(TURN[0]))
    parser = MoveStreamParser()
    assert parser.feed(text[:first_end - 1]) == []
    assert [e.value for e in parser.feed(text[first_end - 1:first_end])] == [TURN[0]]


TRICKY = [
    {"type": "say", "text": 'He said "softmax" {not a brace} [nor a bracket] \\ done'},
    {"type": "equation", "latex": "\\frac{QK^\\top}{\\sqrt{d_k}} \\\\ \\text{\"quoted\"}"},
    {"type": "write", "text": "caf\u00e9 \\\" \\\\\" end\\"},
    END,
]


def test_parser_handles_every_split_of_escapes_and_quotes():
    text = json.dumps({"moves": TRICKY})
    assert "\\\\\\\"" in text  # an escaped backslash followed by an escaped quote
    for cut in range(1, len(text)):
        assert [e.value for e in parse([text[:cut], text[cut:]])] == TRICKY, cut


def test_parser_tracks_unicode_escapes_and_ignores_other_keys():
    text = '{"other": [{"type": "say"}], "moves": [{"type": "say", "text": "\\u00e9\\u005c"}]}'
    assert [e.value for e in parse(chunks(text, 5))] == [{"type": "say", "text": "\u00e9\\"}]


def test_invalid_element_is_reported_and_stream_continues():
    text = '{"moves": [{"type": "say", "text": "x",}, {"type": "turn_end", "reason": "done"}]}'
    bad, good = parse([text])
    assert bad.value is None and bad.error.startswith("invalid JSON") and bad.raw.startswith('{"type"')
    assert good.value == END


def test_truncated_turn_keeps_emitted_moves():
    text = json.dumps({"moves": TRICKY})
    parser = MoveStreamParser()
    emitted = parser.feed(text[:text.index('"type": "write"') + 5])
    assert [e.value for e in emitted] == TRICKY[:2]
    with pytest.raises(MoveSyntaxError, match="unterminated"):
        parser.close()
    whole = MoveStreamParser()
    whole.feed(text[:-1])
    with pytest.raises(MoveSyntaxError, match="incomplete"):
        whole.close()


@pytest.mark.parametrize("text, message", [
    ('{"moves": ["say"]}', "objects"),
    ('{"moves": [1]}', "objects"),
    ('{"moves": [[]]}', "objects"),
    ('[{"type": "say"}]', "JSON object"),
    ('{"moves": []} {"moves": []}', "trailing"),
    ('{"moves": []} x', "trailing"),
])
def test_structural_errors(text, message):
    with pytest.raises(MoveSyntaxError, match=message):
        parse([text])


def test_parser_limits():
    with pytest.raises(MoveSyntaxError, match="size limit"):
        MoveStreamParser(max_chars=50).feed('{"moves": [{"type": "say", "text": "' + "x" * 60)
    with pytest.raises(MoveSyntaxError, match="move limit"):
        parse([json.dumps({"moves": [END] * 65})])


# ---------- learner contracts ----------

def test_fixture_learner_contracts_validate():
    observations = [Observation.model_validate(o) for o in FIXTURE["observations"]]
    profile = ProfileRevision.model_validate(FIXTURE["profile_revision"])
    graph = ConstellationGraph.model_validate(FIXTURE["constellation"])
    assert set(profile.observation_ids) == {o.observation_id for o in observations}
    assert {"M3", "N2"} <= BRIEF.refs
    assert graph.revision == graph.revisions[-1].revision == 2
    states = {n.state for n in graph.nodes} | {n.state for r in graph.revisions for n in r.nodes}
    assert states == {"solid", "shaky", "misconception", "learning", "unseen"}
    cited = {i for note in profile.notes for i in note.cites}
    assert cited <= set(profile.observation_ids)


def amend(data, **changes):
    return {**data, **changes}


OBS = FIXTURE["observations"][0]


@pytest.mark.parametrize("model, data", [
    (Observation, amend(FIXTURE["observations"][1], misconception="softmax_is_linear_normalization")),
    (Observation, amend(OBS, sources=[])),
    (Observation, amend(OBS, sources=[{**OBS["sources"][0], "author": "model"}])),
    (Observation, amend(OBS, dimension="conceptual")),
    (Observation, amend(OBS, miss_class="guess")),
    (Observation, amend(OBS, outcome="unanswered")),
    (LearnerBrief, amend(FIXTURE["brief"], items=FIXTURE["brief"]["items"] * 2)),
    (LearnerBrief, amend(FIXTURE["brief"], items=[{**FIXTURE["brief"]["items"][0], "id": "known-1"}])),
    (LearnerBrief, amend(FIXTURE["brief"], items=[{**FIXTURE["brief"]["items"][0], "id": f"N{i}", "text": "x" * 280}
                                                  for i in range(9)])),
    (ProfileRevision, amend(FIXTURE["profile_revision"], beliefs=FIXTURE["profile_revision"]["beliefs"][:1] * 2)),
    (ProfileRevision, amend(FIXTURE["profile_revision"], parent_revision=1)),
    (ProfileRevision, amend(FIXTURE["profile_revision"], notes=[{"text": "uncited", "cites": []}])),
    (ConstellationGraph, amend(FIXTURE["constellation"], edges=[{"source": "softmax", "target": "nope", "kind": "related"}])),
    (ConstellationGraph, amend(FIXTURE["constellation"], edges=[{"source": "softmax", "target": "softmax", "kind": "related"}])),
    (ConstellationGraph, amend(FIXTURE["constellation"], revisions=FIXTURE["constellation"]["revisions"][::-1])),
    (ConstellationGraph, amend(FIXTURE["constellation"], revision=3)),
    (ConstellationGraph, amend(FIXTURE["constellation"], nodes=FIXTURE["constellation"]["nodes"] * 15)),
])
def test_learner_contracts_reject_invalid(model, data):
    with pytest.raises(ValidationError):
        model.model_validate(data)


def test_belief_mean():
    assert Belief(concept="softmax", dimension="understand", alpha=1, beta=3).mean == 0.25
