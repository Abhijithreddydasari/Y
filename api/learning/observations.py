"""Learner evidence from answered predict/check cards: verify first, record once, label later.

Deterministic verifiers grade what they can and audit the tutor's key. A typed decision model
(Muse Spark Open by default) then labels outcome, miss class and misconception in the background; teaching never
waits for it and a labeling failure is visible only in the evidence trace. Nothing here writes a
learner profile (H5 reduces observations at session close).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import re
import time
from datetime import datetime, timezone
from uuid import UUID, uuid4

import anyio
from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError

from .contracts import Assistance, canonical, digest, now_iso
from .decisions import EVIDENCE_QUESTIONS, REASONING_SCORE, EvidenceLabelProvider, ProviderFailure
from .learner_contracts import EvidenceSource, Observation
from .storage import CaptureStore, StoreError, observations

log = logging.getLogger("y.evidence")

# ---------------------------------------------------------------------------------------------
# Safe expressions: a recursive-descent parser compiled to closures. Never eval learner text.

FUNCTIONS = {"sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan, "exp": math.exp,
             "log": math.log, "ln": math.log, "abs": abs}
CONSTANTS = {"pi": math.pi, "e": math.e}
MAX_CHARS, MAX_DEPTH, MAX_VARIABLES = 200, 40, 4
TOKEN = re.compile(r"\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z]+)|(\*\*|[-+*/^(),%]))")
LATEX = [(r"\\left|\\right|\\displaystyle|\\,|\\;|\\!|\\quad|\$", ""), (r"\\(?:times|cdot|ast)", "*"), (r"\\div", "/"),
         (r"\\pi\b", "pi"), (r"\\(sqrt|sin|cos|tan|exp|log|ln)\b", r"\1"), (r"[−–]", "-"), (r"×|·", "*"), (r"÷", "/"),
         (r"√", "sqrt"), (r"π", "pi")]


class ExprError(ValueError):
    pass


def plain(text: str) -> str:
    """LaTeX and typographic math to the parser's plain syntax; `\\frac{a}{b}` becomes `((a)/(b))`."""
    value = text.strip()
    for pattern, replacement in LATEX:
        value = re.sub(pattern, replacement, value)
    for _ in range(8):
        value, count = re.subn(r"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"((\1)/(\2))", value)
        if not count:
            break
    value = re.sub(r"sqrt\s*\{([^{}]*)\}", r"sqrt(\1)", value)
    if "\\" in value:
        raise ExprError("unsupported LaTeX")
    return value.replace("{", "(").replace("}", ")")


def _tokens(text: str) -> list[str]:
    out, position = [], 0
    while position < len(text):
        if text[position:].strip() == "":
            break
        match = TOKEN.match(text, position)
        if not match:
            raise ExprError("unexpected character")
        number, name, symbol = match.groups()
        if name:
            lower = name.lower()
            if len(name) > 1 and (lower in FUNCTIONS or lower in CONSTANTS):
                out.append(lower)
            elif len(name) <= 3:  # `xy` is x·y; longer words are prose, not maths
                out.extend(name)
            else:
                raise ExprError("unknown name")
        else:
            out.append(number or ("^" if symbol == "**" else symbol))
        position = match.end()
    return out


def compile_expr(text: str):
    """Returns (fn(env) -> float, variable names). Raises ExprError for anything outside the grammar."""
    if len(text) > MAX_CHARS:
        raise ExprError("too long")
    tokens, names = _tokens(plain(text)), set()
    if not tokens:
        raise ExprError("empty")
    index = 0

    def peek():
        return tokens[index] if index < len(tokens) else None

    def take():
        nonlocal index
        index += 1
        return tokens[index - 1]

    def starts_atom(token):
        return token is not None and (token == "(" or token[0].isdigit() or token[0] == "." or token[0].isalpha())

    def expr(depth):
        if depth > MAX_DEPTH:
            raise ExprError("too deep")
        left = term(depth + 1)
        while peek() in ("+", "-"):
            op, right = take(), term(depth + 1)
            left = (lambda a, b: lambda env: a(env) + b(env))(left, right) if op == "+" else \
                   (lambda a, b: lambda env: a(env) - b(env))(left, right)
        return left

    def term(depth):
        left = unary(depth + 1)
        while peek() in ("*", "/") or starts_atom(peek()):
            op = take() if peek() in ("*", "/") else "*"
            right = unary(depth + 1)
            left = (lambda a, b: lambda env: a(env) * b(env))(left, right) if op == "*" else \
                   (lambda a, b: lambda env: a(env) / b(env))(left, right)
        return left

    def unary(depth):
        if depth > MAX_DEPTH:
            raise ExprError("too deep")
        if peek() in ("-", "+"):
            sign = take()
            inner = unary(depth + 1)
            return (lambda a: lambda env: -a(env))(inner) if sign == "-" else inner
        return power(depth + 1)

    def power(depth):
        base = postfix(depth + 1)
        if peek() == "^":
            take()
            exponent = unary(depth + 1)
            return (lambda a, b: lambda env: a(env) ** b(env))(base, exponent)
        return base

    def postfix(depth):
        value = atom(depth + 1)
        while peek() == "%":
            take()
            value = (lambda a: lambda env: a(env) / 100)(value)
        return value

    def atom(depth):
        if depth > MAX_DEPTH:
            raise ExprError("too deep")
        token = take() if peek() is not None else None
        if token is None:
            raise ExprError("unexpected end")
        if token == "(":
            inner = expr(depth + 1)
            if peek() != ")":
                raise ExprError("unbalanced")
            take()
            return inner
        if token[0].isdigit() or token[0] == ".":
            number = float(token)
            return lambda env: number
        if token in CONSTANTS:
            constant = CONSTANTS[token]
            return lambda env: constant
        if token in FUNCTIONS:
            fn, argument = FUNCTIONS[token], power(depth + 1) if peek() != "(" else atom(depth + 1)
            return lambda env: fn(argument(env))
        if token.isalpha() and len(token) == 1:
            names.add(token)
            return lambda env: env[token]
        raise ExprError("unexpected token")

    fn = expr(0)
    if index != len(tokens):
        raise ExprError("trailing input")
    if len(names) > MAX_VARIABLES:
        raise ExprError("too many variables")
    return fn, frozenset(names)


def _evaluate(fn, env) -> float | None:
    try:
        value = fn(env)
    except (ArithmeticError, ValueError, TypeError, OverflowError):
        return None
    if isinstance(value, complex) or not math.isfinite(value):
        return None
    return float(value)


ANSWER_PREFIX = re.compile(r"^\s*(?:(?:it'?s|is|about|approximately|approx\.?|roughly|around|~|≈)\s*)+", re.I)
ASSIGNMENT = re.compile(r"^\s*[A-Za-z](?:_\{?\w+\}?)?\s*(?:=|≈)\s*")


def number_of(text: str) -> tuple[float, float] | None:
    """(value, tolerance) of a closed numeric answer such as `25/3`, `\\frac{1}{2}`, `x = 4`, `12.5%`."""
    cleaned = ASSIGNMENT.sub("", ANSWER_PREFIX.sub("", text.strip())).rstrip(". ")
    if not cleaned or len(cleaned) > 100:
        return None
    try:
        fn, names = compile_expr(cleaned)
    except ExprError:
        return None
    if names:
        return None
    value = _evaluate(fn, {})
    if value is None:
        return None
    decimals = re.fullmatch(r"[+-]?\d*\.(\d+)", cleaned)
    # A rounded key (22.6) accepts anything that rounds to it; exact forms compare tightly.
    tolerance = 0.5 * 10 ** -len(decimals.group(1)) if decimals else 0.0
    return value, tolerance


def numbers_agree(a: tuple[float, float], b: tuple[float, float]) -> bool:
    tolerance = max(a[1], b[1], 1e-9, 1e-6 * max(abs(a[0]), abs(b[0])))
    return abs(a[0] - b[0]) <= tolerance + 1e-12


MATHY = re.compile(r"[\d+\-*/^=()\\]")


def symbolic_equal(left: str, right: str, points: int = 8) -> bool | None:
    """Equal if both agree at seeded random points; None when either is not an expression we can read."""
    if not (MATHY.search(left) and MATHY.search(right)):
        return None  # "yes" vs "no" is prose, not y·e·s
    try:
        (f, fv), (g, gv) = compile_expr(plain(ASSIGNMENT.sub("", left))), compile_expr(plain(ASSIGNMENT.sub("", right)))
    except ExprError:
        return None
    names = sorted(fv | gv)
    if len(names) > MAX_VARIABLES or not names:
        return None
    rng, valid = random.Random(17), 0
    for _ in range(points * 2):
        env = {name: rng.uniform(0.5, 2.5) for name in names}
        a, b = _evaluate(f, env), _evaluate(g, env)
        if a is None or b is None:
            continue
        if not math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9):
            return False
        valid += 1
        if valid >= points:
            return True
    return None if valid < 5 else True


# ---------------------------------------------------------------------------------------------
# Verifiers and the key audit


def verify(question: dict, answer: str, key: str | None = None) -> dict:
    """{"result": correct|incorrect|None, "method": ...}; None means not verifiable, never wrong."""
    key = question["key"] if key is None else key
    if question["kind"] in ("predict", "mcq"):
        return {"result": "correct" if answer == key else "incorrect", "method": "option"}
    if answer.strip().casefold() == key.strip().casefold():
        return {"result": "correct", "method": "exact"}
    mine, theirs = number_of(answer), number_of(key)
    if mine is not None and theirs is not None:
        return {"result": "correct" if numbers_agree(mine, theirs) else "incorrect", "method": "numeric"}
    same = symbolic_equal(answer, key)
    if same is not None:
        return {"result": "correct" if same else "incorrect", "method": "symbolic"}
    return {"result": None, "method": None}


MATH_SPAN = re.compile(r"\$\$(.+?)\$\$|\$(.+?)\$|\\\((.+?)\\\)|\\\[(.+?)\\\]", re.S)
# Runs of numbers, operators and LaTeX maths commands inside prose ("What is 7 \times 8?").
MATH_RUN = re.compile(r"(?:\\(?:frac|dfrac|sqrt|times|cdot|div|pi|left|right)|[\d.+\-*/^(){}×·÷√−% ])+")
# A real computation: an operator between operands, or a fraction or root.
BINARY = re.compile(r"[\d)}]\s*(?:[+\-*/^×·÷−]|\\(?:times|cdot|div))\s*[\d({\\√.]|\\(?:frac|dfrac|sqrt)|√")


def _runs(text: str) -> list[str]:
    """Numeric runs in prose that are not part of a larger expression with variables (`3x + 5` is skipped)."""
    out = []
    for match in MATH_RUN.finditer(text):
        raw = match.group(0)
        start = match.start() + len(raw) - len(raw.lstrip())
        end = match.end() - (len(raw) - len(raw.rstrip()))
        run = text[start:end]
        if not run or not (run[0].isdigit() or run[0] in "(\\√."):
            continue
        before, after = text[start - 1] if start else " ", text[end] if end < len(text) else " "
        if before.isalpha() or before == "_" or after.isalpha() or after == "_":
            continue
        out.append(run)
    return out


def _closed_values(text: str) -> list[float]:
    spans = [next(g for g in m.groups() if g) for m in MATH_SPAN.finditer(text)] or _runs(text)
    values = []
    for span in spans:
        span = span.strip(" ?.,").split("=")[0].strip()
        if not re.search(r"\d", span) or not BINARY.search(span):
            continue
        try:
            fn, names = compile_expr(span)
        except ExprError:
            continue
        value = None if names else _evaluate(fn, {})
        if value is not None:
            values.append(value)
    return values


def audit_key(question: dict) -> dict:
    """Recompute the question's single closed numeric expression, if it has one, and compare it with the key.

    {"status": ok|wrong, "recomputed": str|None, "corrected_key": str|None}. Only a confident
    mismatch marks a key wrong; anything else stays "ok" for Elephant's second opinion.
    """
    values = _closed_values(question["q"])
    distinct = {round(v, 9) for v in values}
    if len(distinct) != 1:
        return {"status": "ok", "recomputed": None, "corrected_key": None}
    value = values[0]
    shown = f"{value:.6g}"
    target = (value, 1e-9)
    if question["kind"] in ("predict", "mcq"):
        stated = number_of(question["key"])
        if stated is None or numbers_agree(stated, target):
            return {"status": "ok", "recomputed": shown, "corrected_key": None}
        matches = [o for o in question["options"] if (n := number_of(o)) is not None and numbers_agree(n, target)]
        return {"status": "wrong", "recomputed": shown, "corrected_key": matches[0] if len(matches) == 1 else None}
    stated = number_of(question["key"])
    if stated is None or numbers_agree(stated, target):
        return {"status": "ok", "recomputed": shown, "corrected_key": None}
    return {"status": "wrong", "recomputed": shown, "corrected_key": shown}


# ---------------------------------------------------------------------------------------------
# Observation building


def modality_of(via: str | None, choice: str | None) -> str:
    return via or ("tap" if choice else "typed")


def format_weight(question: dict, modality: str, revealed: bool) -> float:
    """Guessable taps weigh 1 - 1/n, predicts 0.5; spoken and ink carry transcription noise; a reveal halves it."""
    if question["kind"] == "predict":
        weight = 0.5
    elif question["kind"] == "mcq":
        weight = 1 - 1 / max(2, len(question["options"]))
    else:
        weight = 1.0
    if modality in ("spoken", "ink"):
        weight *= 0.9
    if revealed:
        weight *= 0.5
    return round(weight, 4)


def slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", text.casefold()).strip("-")[:48].strip("-")
    return value or "item"


def concept_of(question: dict, history: list[dict]) -> tuple[str, str]:
    """A predict has no concept: borrow the session's latest check concept, else its turn's first goal."""
    if question.get("concept"):
        return question["concept"], question["dim"]
    for turn in reversed(history):
        asked = turn.get("question") or {}
        if asked.get("concept"):
            return asked["concept"], "understand"
    owner = next((t for t in history if (t.get("question") or {}).get("qid") == question["qid"]), None)
    goal = next((m["goal"] for m in (owner or {}).get("moves", []) if m.get("type") == "seg"), "")
    return f"topic:{slug(goal or question['q'])}", "understand"


def misconception_candidates(question: dict, concept: str, seen: list[str],
                             earlier: dict[str, str] | None = None) -> dict[str, str]:
    """Option -> meaning for the decision model: this check's wrong options, then misconceptions already seen for the
    concept in this session, then ones the learner's profile holds for it from earlier sessions."""
    criteria = {"none": "No misconception: the answer is right or the miss is a slip.",
                "other": "A misconception, but none of the listed ones."}
    for option in question["options"]:
        if option != question["key"]:
            criteria[f"{concept}/{slug(option)}"[:120]] = f"The learner believes: {option}"[:300]
    for mid in seen:
        if len(criteria) >= 8:
            break
        criteria.setdefault(mid, f"The learner shows the earlier misconception {mid}.")
    for mid, description in (earlier or {}).items():
        if len(criteria) >= 8:
            break
        criteria.setdefault(mid, f"Seen in an earlier session. {description}"[:300])
    return dict(list(criteria.items())[:8])


def build_observation(row: dict, outcome: str, *, misconception=None, miss_class=None, labeler="deterministic",
                      label_confidence=None, **soft) -> Observation:
    question, value = json.loads(row["question_json"]), json.loads(row["verifier_json"])
    if outcome == "correct":
        misconception = miss_class = None
    if outcome == "unanswered":
        miss_class = None
    return Observation(
        observation_id=UUID(row["observation_id"]), session_id=UUID(row["session_id"]), check_id=row["qid"],
        concept=value["concept"], dimension=value["dimension"], outcome=outcome, misconception=misconception,
        miss_class=miss_class, assistance=Assistance(solution_revealed=value["revealed"],
                                                                   hint_ids=tuple(value.get("hint_ids", ()))), confidence=value["confidence"],
        labeler=labeler, label_confidence=label_confidence, format_weight=value["format_weight"], key_status=row["key_status"],
        **soft,
        sources=(EvidenceSource(event_id=UUID(row["turn_id"]), modality=row["modality"], content_hash=digest(row["answer_text"]),
                                element_ids=tuple(value.get("element_ids", ()))),),
        created_at=value["created_at"])


# ---------------------------------------------------------------------------------------------
# Storage

LEASE_SECONDS = 30
MAX_CROPS = 2  # the existing per-call image cap
# Failures a later attempt can fix (a key added, a provider back, a new hour of budget).
RETRYABLE = frozenset({"provider_auth_failed", "provider_timeout", "provider_rate_limited", "provider_http_error",
                       "provider_unavailable", "provider_invalid_response", "label_budget", "labeler_not_configured",
                       "label_failed", "label_store_failed"})
HOURLY_LABELS, HOURLY_LABELS_GLOBAL = 60, 300
_ready: set[int] = set()


def _view(row) -> dict:
    observation = json.loads(row["observation_json"]) if row["observation_json"] else None
    label = json.loads(row["label_json"]) if row["label_json"] else None
    return {"observation_id": row["observation_id"], "qid": row["qid"], "turn_id": row["turn_id"], "status": row["status"],
            "modality": row["modality"], "key_status": row["key_status"], "error": row["error"],
            "duplicates": row["duplicates"], "label_ms": row["label_ms"] and round(row["label_ms"]),
            "verifier": json.loads(row["verifier_json"]).get("verifier"), "observation": observation,
            "fields": (label or {}).get("fields"),
            "label": label and {k: label.get(k) for k in ("provider", "model", "provider_ms", "queue_ms", "images")}}


class ObservationStore:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine
        if id(self.engine) not in _ready:
            observations.create(self.engine, checkfirst=True)
            _ready.add(id(self.engine))

    def capture_answer(self, owner: str, sid: str, turn_id: str, question: dict, answer: str, graded: dict,
                       modality: str, history: list[dict], element_ids: tuple[str, ...] = (),
                       crops: tuple[str, ...] = (), hint_ids: tuple[str, ...] = (), at: float | None = None) -> tuple[dict, bool]:
        """Insert-or-get on (session_id, qid). Returns (row view, created); a repeat only counts a duplicate.
        `at` backdates the answer (seeded demo history only)."""
        stamp = time.time() if at is None else at
        concept, dimension = concept_of(question, history)
        revealed = graded["result"] == "revealed"
        verifier = {"result": graded.get("verified"), "method": graded.get("method"),
                    "recomputed": graded.get("recomputed"), "corrected_key": graded.get("corrected_key")}
        value = {"concept": concept, "dimension": dimension, "revealed": revealed, "confidence":
                 None if graded.get("confidence") is None else graded["confidence"] / 100,
                 "format_weight": format_weight(question, modality, revealed), "element_ids": list(element_ids),
                 "crop_hashes": list(crops[:MAX_CROPS]), "hint_ids": list(hint_ids),
                 "verifier": verifier, "created_at": now_iso() if at is None else
                 datetime.fromtimestamp(stamp, timezone.utc).isoformat()}
        row = {"observation_id": str(uuid4()), "session_id": sid, "owner_id": owner, "qid": question["qid"],
               "turn_id": turn_id, "modality": modality, "question_json": canonical(question), "answer_text": answer,
               "verifier_json": canonical(value), "key_status": graded.get("key_status", "ok"), "duplicates": 0,
               "lease_until": 0, "created_at": stamp}
        # Revealed: nothing to label. Otherwise a deterministic result is recorded now and Elephant refines it.
        deterministic = "unanswered" if revealed else verifier["result"]
        row["status"] = "deterministic" if revealed else "pending"
        if deterministic:
            row["observation_json"] = canonical(build_observation(row, deterministic, label_confidence=1.0))
        with self.engine.begin() as conn:
            self.capture._session(conn, owner, sid)
            try:
                with conn.begin_nested():
                    conn.execute(insert(observations).values(**row))
                created = True
            except IntegrityError:
                conn.execute(update(observations).where(observations.c.session_id == sid, observations.c.qid == question["qid"])
                             .values(duplicates=observations.c.duplicates + 1))
                created = False
            stored = conn.execute(select(observations).where(observations.c.session_id == sid,
                                                             observations.c.qid == question["qid"])).mappings().first()
        return _view(stored), created

    def claim(self, owner: str, observation_id: str, charge: bool = True) -> dict | None:
        """Lease a pending row for labeling and charge the label budget; None if another worker has it."""
        now = time.time()
        with self.engine.begin() as conn:
            changed = conn.execute(update(observations).where(
                observations.c.observation_id == observation_id, observations.c.owner_id == owner,
                observations.c.status == "pending", observations.c.lease_until < now).values(lease_until=now + LEASE_SECONDS))
            if changed.rowcount != 1:
                return None
            if charge:
                hour = int(now // 3600)
                try:
                    with conn.begin_nested():
                        self.capture._spend(conn, f"label-global:{hour}", HOURLY_LABELS_GLOBAL)
                        self.capture._spend(conn, f"label-{owner}:{hour}", HOURLY_LABELS)
                except StoreError:
                    conn.execute(update(observations).where(observations.c.observation_id == observation_id)
                                 .values(status="failed", error="label_budget", lease_until=0))
                    return None
            return dict(conn.execute(select(observations).where(observations.c.observation_id == observation_id)).mappings().first())

    def finish(self, observation_id: str, status: str, observation: Observation | None, label: dict | None,
               error: str | None, ms: float | None, key_status: str | None = None) -> None:
        values = {"status": status, "error": error, "label_ms": ms, "lease_until": 0}
        if observation is not None:
            values["observation_json"] = canonical(observation)
        if label is not None:
            values["label_json"] = canonical(label)
        if key_status is not None:
            values["key_status"] = key_status
        with self.engine.begin() as conn:
            conn.execute(update(observations).where(observations.c.observation_id == observation_id,
                                                    observations.c.status == "pending").values(**values))

    def entries(self, owner: str, sid: str) -> list[dict]:
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, sid)
            rows = conn.execute(select(observations).where(observations.c.session_id == sid)
                                .order_by(observations.c.created_at)).mappings()
            return [_view(row) for row in rows]

    def requeue(self, owner: str, sid: str) -> list[str]:
        """Rows worth one more label at session close: pending ones, and retryable failures with no observation."""
        with self.engine.begin() as conn:
            self.capture._session(conn, owner, sid)
            rows = conn.execute(select(observations.c.observation_id, observations.c.status, observations.c.error,
                                       observations.c.observation_json).where(
                observations.c.session_id == sid, observations.c.owner_id == owner)).mappings().all()
            again = [r["observation_id"] for r in rows if r["status"] == "failed" and r["observation_json"] is None
                     and r["error"] in RETRYABLE]
            if again:
                conn.execute(update(observations).where(observations.c.observation_id.in_(again))
                             .values(status="pending", error=None, lease_until=0))
        return [r["observation_id"] for r in rows if r["status"] == "pending"] + again

    def sealed(self, owner: str, sid: str) -> tuple[list[Observation], list[dict]]:
        """(observations to reduce, rows left out with their status and error)."""
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, sid)
            rows = conn.execute(select(observations).where(observations.c.session_id == sid)
                                .order_by(observations.c.created_at)).mappings().all()
        found = [Observation.model_validate_json(r["observation_json"]) for r in rows if r["observation_json"]]
        left = [{"observation_id": r["observation_id"], "status": r["status"], "error": r["error"]}
                for r in rows if not r["observation_json"]]
        return found, left

    def misconception_texts(self, sid: str) -> dict[str, str]:
        """Misconception id -> the wrong option's full wording (ids are cut to 48-character slugs)."""
        out = {}
        with self.engine.connect() as conn:
            rows = conn.execute(select(observations.c.question_json, observations.c.observation_json).where(
                observations.c.session_id == sid, observations.c.observation_json.is_not(None)))
            for question_json, observation_json in rows:
                found, question = json.loads(observation_json), json.loads(question_json)
                for option in question["options"]:
                    mid = f"{found['concept']}/{slug(option)}"[:120]
                    if mid == found["misconception"]:
                        out[mid] = f"On {found['concept']}: believes {option}"[:400]
        return out

    def answers(self, sid: str) -> dict[str, dict]:
        """observation id -> the learner's answer text and question prompt, for teaching notes."""
        with self.engine.connect() as conn:
            rows = conn.execute(select(observations.c.observation_id, observations.c.answer_text,
                                       observations.c.question_json).where(observations.c.session_id == sid))
            return {r[0]: {"answer": r[1], "q": json.loads(r[2])["q"]} for r in rows}

    def digest(self, owner: str, ids: list[str], chars: int = 160) -> list[dict]:
        """The learner map's cited events: what was asked and answered, owner-scoped, text cut to `chars`."""
        out = []
        with self.engine.connect() as conn:
            for start in range(0, len(ids), 200):
                rows = conn.execute(select(observations.c.observation_id, observations.c.answer_text,
                                           observations.c.question_json, observations.c.observation_json).where(
                    observations.c.owner_id == owner, observations.c.observation_id.in_(ids[start:start + 200]),
                    observations.c.observation_json.is_not(None)))
                for oid, answer, question_json, observation_json in rows:
                    o = json.loads(observation_json)
                    out.append({"id": oid, "concept": o["concept"], "dimension": o["dimension"], "outcome": o["outcome"],
                                "modality": o["sources"][0]["modality"] if o.get("sources") else None,
                                "created_at": o["created_at"], "question": (json.loads(question_json).get("q") or "")[:chars],
                                "answer": (answer or "")[:chars]})
        return sorted(out, key=lambda e: (e["created_at"], e["id"]))

    def crop_images(self, owner: str, row: dict) -> tuple[tuple[str, bytes], ...]:
        """The learner's own ink crops recorded with the answer; a missing asset is skipped."""
        from .board_storage import BoardStore
        hashes = json.loads(row["verifier_json"]).get("crop_hashes") or []
        boards, images = BoardStore(self.capture), []
        for key in hashes[:MAX_CROPS]:
            try:
                asset = boards.get_asset(owner, row["session_id"], key)
            except StoreError:
                continue
            images.append((asset["mime"], asset["content"]))
        return tuple(images)

    def earlier_misconceptions(self, owner: str, concept: str) -> dict[str, str]:
        """Active or suspected misconceptions on this concept from the owner's profile: id -> description."""
        from .profile import ProfileStore
        revision, _ = ProfileStore(self.capture).latest(owner)
        return {m.id: m.description for m in (revision.misconceptions if revision else ())
                if m.concept == concept and m.status != "resolved"}

    def seen_misconceptions(self, sid: str, concept: str) -> list[str]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(observations.c.observation_json).where(
                observations.c.session_id == sid, observations.c.observation_json.is_not(None)))
            found = [json.loads(r[0]) for r in rows]
        return list(dict.fromkeys(o["misconception"] for o in found if o["concept"] == concept and o["misconception"]))


# ---------------------------------------------------------------------------------------------
# Background labeling

CONCURRENCY = 4  # one decision call is ~0.2-0.5 s (measured 2026-11-02); 2 slots queued a 14-answer burst for seconds
ACCEPT = 0.5  # a discrete field (miss class, key validity, top misconception) is taken only at this probability
MISCONCEPTION_FLOOR = 0.05  # smaller candidate probabilities are not kept on the observation
REASONING_WORDS = 4  # a typed or spoken answer this short is a bare result, so reasoning is not asked
_slots: dict[int, asyncio.Semaphore] = {}
_running: set[asyncio.Task] = set()


def _slot() -> asyncio.Semaphore:
    loop = id(asyncio.get_running_loop())
    if loop not in _slots:
        _slots[loop] = asyncio.Semaphore(CONCURRENCY)
    return _slots[loop]


def label_request(row: dict, seen: list[str], earlier: dict[str, str] | None = None) -> tuple[dict, dict]:
    """The state the decision model sees and only the questions still open for this answer."""
    question, value = json.loads(row["question_json"]), json.loads(row["verifier_json"])
    state = {"question": question["q"], "options": question["options"], "answer_key": question["key"],
             "learner_answer": row["answer_text"], "answer_format": row["modality"]}
    asked = {"key_valid": EVIDENCE_QUESTIONS["key_valid"]}
    if value["verifier"]["result"] is None:
        asked["outcome"] = EVIDENCE_QUESTIONS["outcome"]
    if value["verifier"]["result"] != "correct":
        asked["miss_class"] = EVIDENCE_QUESTIONS["miss_class"]
        asked["misconception"] = ("Which misconception, if any, does the learner's answer show?",
                                  misconception_candidates(question, value["concept"], seen, earlier))
    if row["modality"] == "ink" or (row["modality"] in ("typed", "spoken")
                                    and len(row["answer_text"].split()) >= REASONING_WORDS):
        asked["reasoning"] = EVIDENCE_QUESTIONS["reasoning"]
    return state, asked


def merge_labels(row: dict, response, provider: str = "baseten") -> tuple[Observation | None, dict, str]:
    """Combine verifier and decision-model fields; returns (observation or None, label trace, key status).

    The outcome keeps its whole distribution (the reducer updates on expected credit), as do the
    misconception candidates and reasoning. Discrete fields (miss class, key validity, the single
    misconception named on the observation) are taken only at ACCEPT.
    """
    value = json.loads(row["verifier_json"])
    answers = response.answers
    dist = {name: dict(a.probabilities) for name, a in answers.items()}
    fields = {}

    def pick(name):
        if name not in answers:
            return None
        choice = answers[name].choice
        p = dist[name][choice]
        fields[name] = {"choice": choice, "p": round(p, 4), "source": provider, "taken": p >= ACCEPT}
        return choice if p >= ACCEPT else None

    outcome, outcome_p, confidence = value["verifier"]["result"], None, 1.0
    if outcome:
        fields["outcome"] = {"choice": outcome, "p": 1.0, "source": "deterministic", "taken": True}
    elif "outcome" in answers:
        outcome = answers["outcome"].choice
        outcome_p = {k: round(p, 4) for k, p in dist["outcome"].items()}
        confidence = round(dist["outcome"][outcome], 4)
        fields["outcome"] = {"choice": outcome, "p": confidence, "source": provider, "taken": True}
    miss = pick("miss_class")
    mis = pick("misconception")
    key_valid = pick("key_valid")
    soft = {}
    if "misconception" in dist:
        soft["misconception_p"] = {k: round(p, 4) for k, p in dist["misconception"].items()
                                   if k not in ("none", "other") and p >= MISCONCEPTION_FLOOR}
        soft["other_misconception_p"] = round(dist["misconception"].get("other", 0.0), 4)
    if "reasoning" in dist:
        shown = 1 - dist["reasoning"].get("not_shown", 0.0)
        soft["reasoning_shown"] = round(max(0.0, shown), 4)
        if shown > 0.05:
            soft["reasoning"] = round(min(1.0, sum(REASONING_SCORE[k] * p for k, p in dist["reasoning"].items()
                                                   if k in REASONING_SCORE) / shown), 4)
        top = answers["reasoning"].choice
        fields["reasoning"] = {"choice": top, "p": round(dist["reasoning"][top], 4), "source": provider,
                               "taken": True, "score": soft.get("reasoning")}
    key_status = row["key_status"]
    if key_status == "ok" and key_valid == "invalid":
        key_status = "suspect"
    label = {"provider": provider, "model": response.model, "usage": response.usage.model_dump(), "fields": fields,
             "distributions": dist}
    if outcome is None:
        return None, label, key_status
    observation = build_observation(
        {**row, "key_status": key_status}, outcome, misconception=None if mis in (None, "none", "other") else mis,
        miss_class=None if miss in (None, "none") else miss, labeler=provider if answers else "deterministic",
        label_confidence=confidence, outcome_p=outcome_p, **soft)
    return observation, label, key_status


async def label(store: ObservationStore, labeler: EvidenceLabelProvider, owner: str, observation_id: str) -> None:
    """Label one pending observation. Every failure is recorded on the row and never reaches the learner."""
    started = time.perf_counter()
    if not labeler.configured:  # no key: recorded as failed, no budget charged
        if await anyio.to_thread.run_sync(lambda: store.claim(owner, observation_id, charge=False)):
            await anyio.to_thread.run_sync(lambda: store.finish(observation_id, "failed", None, None, "labeler_not_configured", 0))
        return
    row = None
    try:
        async with _slot():
            row = await anyio.to_thread.run_sync(lambda: store.claim(owner, observation_id))
            if row is None:
                return
            concept = json.loads(row["verifier_json"])["concept"]
            seen = await anyio.to_thread.run_sync(lambda: store.seen_misconceptions(row["session_id"], concept))
            earlier = await anyio.to_thread.run_sync(lambda: store.earlier_misconceptions(owner, concept))
            state, asked = label_request(row, seen, earlier)
            images = await anyio.to_thread.run_sync(lambda: store.crop_images(owner, row)) if row["modality"] == "ink" else ()
            called = time.perf_counter()
            with anyio.fail_after(labeler.timeout + 2):
                response, _raw = await labeler.label(state, asked, images)
            provider_ms = (time.perf_counter() - called) * 1000
        observation, trace, key_status = merge_labels(row, response, labeler.provider_name)
        # label_ms is end to end (slot wait included); provider_ms is the HTTP call alone.
        trace.update(images=len(images), provider_ms=round(provider_ms), queue_ms=round((called - started) * 1000))
        ms = (time.perf_counter() - started) * 1000
        status = "labeled" if observation is not None else "failed"
        error = None if observation is not None else "label_uncertain"
        await anyio.to_thread.run_sync(lambda: store.finish(observation_id, status, observation, trace, error, ms, key_status))
        log.info("evidence %s %s in %.0f ms", observation_id, status, ms)
    except BaseException as exc:
        code = (exc.code if isinstance(exc, ProviderFailure) else "label_store_failed" if isinstance(exc, StoreError)
                else "provider_timeout" if isinstance(exc, TimeoutError) else "label_failed")
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(lambda: store.finish(observation_id, "failed", None, None, code,
                                                                (time.perf_counter() - started) * 1000))
        log.warning("evidence %s label failed: %s (%s)", observation_id, code, type(exc).__name__)
        if not isinstance(exc, Exception):
            raise


def start(store: ObservationStore, labeler: EvidenceLabelProvider, owner: str, observation_id: str) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(label(store, labeler, owner, observation_id))
    _running.add(task)
    task.add_done_callback(_running.discard)
    return task
