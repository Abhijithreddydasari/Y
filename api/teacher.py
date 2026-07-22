"""Teacher: abstraction over the LLM that emits lessons.

Two concrete implementations:

  * ``OllamaTeacher`` — local Ollama daemon serving any pulled Gemma 4
    variant (``gemma4:e4b``, ``y-gemma4`` after the LoRA-merged Modelfile is
    built, etc.). Default in dev.
  * ``CloudTeacher`` — Google AI Studio (Gemma 4 31B). High-quality demo
    button. Currently a thin wrapper; P9 of the plan finishes it.

The toolbar's "Edge / Edge fine-tuned / Cloud" dropdown maps directly to
:func:`get_teacher`.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from pathlib import Path
from typing import AsyncIterator, Protocol

import ollama


class TeacherError(RuntimeError):
    pass


class Teacher(Protocol):
    """Common surface used by main.py. Both concrete teachers conform."""

    host: str
    model: str

    def ping(self) -> bool: ...
    def warmup(self) -> None: ...
    def stream_lesson(
        self,
        png_bytes: bytes,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]: ...

    async def educator_notes(self, png_bytes: bytes, lesson_text: str = "") -> dict: ...
    async def extract_evidence(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        safety_identifier: str = "",
    ) -> dict: ...
    async def generate_checkpoint(
        self,
        lesson_text: str,
        learner_state: dict,
        conversation_id: str,
        safety_identifier: str = "",
    ) -> dict: ...
    def stream_assessment_feedback(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        evidence: dict,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]: ...
    def stream_chat(
        self,
        messages: list[dict[str, str]],
        learner_context: str = "",
        lesson_context: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]: ...


PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
LESSON_COMPLETE_MARKER = "[lesson_complete]"


def _lesson_is_complete(text: str) -> bool:
    return LESSON_COMPLETE_MARKER in text.lower()

EDUCATOR_SYSTEM_PROMPT = """You are an instructional coach reviewing a whiteboard lesson.

The student wrote a question on a canvas. A whiteboard tutor is teaching the answer. Your job is to surface what an EDUCATOR would care about: where students typically go wrong on this concept, where to take them next, what they need to know first, and how hard this is.

Reply with a SINGLE valid JSON object, nothing else (no markdown, no commentary, no code fences). Schema:

{
  "misconceptions": [array of 2-4 short strings; common student misunderstandings of this concept],
  "follow_ups": [array of 2-4 short strings; questions a teacher could ask to deepen understanding],
  "prereqs": [array of 2-4 short strings; topics the student should already know],
  "difficulty": "introductory" | "intermediate" | "advanced"
}

Each string should be 6-15 words. Be concrete, not generic. Tailor to the exact concept the student is asking about.
"""

EVIDENCE_SYSTEM_PROMPT = """You are grading one learner's whiteboard answer to a checkpoint.

Return one JSON object and nothing else:
{
  "concepts": [{
    "name": "specific-concept",
    "description": "short description",
    "confidence": 0.0,
    "hierarchy": ["Subject", "Field", "Subfield", "Topic", "Subtopic"],
    "facets": {
      "knowledge": {"score": 0.0, "confidence": 0.0},
      "understanding": {"score": 0.0, "confidence": 0.0},
      "reasoning": {"score": 0.0, "confidence": 0.0},
      "application": {"score": 0.0, "confidence": 0.0}
    }
  }],
  "outcome": {"correct": 0.0, "partial": 0.0, "incorrect": 0.0},
  "independence": 0.0,
  "evidence_strength": 0.0,
  "response_summary": "what the learner attempted",
  "misconception": "specific misconception or empty string",
  "response_text": "short transcription of the learner's answer"
}
The outcome probabilities must sum to 1. Use evidence_strength below 0.65
when handwriting, the rubric, or correctness is ambiguous. Never infer broad
personality traits from one answer. Score a facet only when this answer
actually exposes it; otherwise give that facet confidence 0. Retention is
longitudinal and must not be emitted from one answer. Use the narrowest useful
hierarchy and end it at the assessed concept; omit redundant levels.
"""

CHECKPOINT_SYSTEM_PROMPT = """You write one short check-for-understanding question.

Return one JSON object and nothing else:
{
  "question": "one answerable question, at most 24 words",
  "concepts": ["specific-open-vocabulary-concept"],
  "rubric": "a concise correct-answer rubric for the grader",
  "difficulty": "introductory" | "intermediate" | "transfer"
}
Target uncertain or weakly evidenced concepts. If the learner appears secure,
ask a nearby transfer question. Do not repeat the worked example verbatim.
"""

ASSESSMENT_FEEDBACK_PROMPT = """The attached whiteboard is the learner's answer to a checkpoint.
Use the supplied grading evidence and probabilistic learner profile to give
brief corrective feedback like a teacher at the board. Emit only the existing
whiteboard primitive tags. Use 4-8 tags, no markdown, and end with one [text:]
that says what to try or remember next. Treat low-confidence evidence as
uncertain and never reveal numeric mastery scores.
"""

CHAT_SYSTEM_PROMPT = """You are Y, the same patient tutor currently teaching on the whiteboard.
Continue the educational conversation in clear Markdown. Use short paragraphs,
bullets when useful, and LaTeX ($inline$ or $$display$$) for mathematics. Refer
to the lesson transcript when it is relevant, but never claim to see anything
that is not present in the transcript or conversation. Adapt to the supplied
learner context without exposing scores or hidden profiling. Be concise by
default, show complete working for calculations, and ask a clarifying question
only when the learner's request is genuinely ambiguous. Do not emit whiteboard
primitive tags.
"""


def _chat_instructions(learner_context: str, lesson_context: str) -> str:
    context: list[str] = [CHAT_SYSTEM_PROMPT]
    if learner_context.strip():
        context.append("\nLearner context (private; use only to adjust teaching depth):\n" + learner_context[-4000:])
    if lesson_context.strip():
        context.append("\nCurrent whiteboard lesson transcript:\n" + lesson_context[-12000:])
    return "".join(context)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _load_system_prompt() -> str:
    """Concatenate the instruction prompt (system.md) with the tag vocabulary
    (primitives.md).

    No few-shot example lessons are included: the tutor reasons from the rules
    and the vocabulary rather than imitating canned demonstrations.

    Layout:
        [system.md]
        ---
        [primitives.md]   (already has its own header)
    """
    parts: list[str] = [
        _read(PROMPTS_DIR / "system.md"),
        "\n\n---\n\n",
        _read(PROMPTS_DIR / "primitives.md"),
    ]
    return "".join(parts).strip()


class OllamaTeacher:
    def __init__(self, host: str, model: str) -> None:
        self.host = host
        # Model is configurable via env (MODEL_NAME). Default in main.py is gemma4:e4b.
        self.model = model
        self._client = ollama.Client(host=host)
        self._system_prompt = _load_system_prompt()

    def ping(self) -> bool:
        """Fast liveness check.

        We do NOT call ``self._client.list()`` here directly: the ollama SDK
        retries on connection errors which makes ``/health`` block for ~6s
        per failed daemon. Instead we open a tight TCP socket against the
        host:port; on success we then verify the model is loaded. Localhost
        is dual-stack on Windows (IPv6 + IPv4 each timing out separately),
        so we resolve it to 127.0.0.1 to skip the IPv6 attempt.
        """
        import socket
        from urllib.parse import urlparse

        u = urlparse(self.host)
        host = u.hostname or "localhost"
        if host in {"localhost", "::1"}:
            host = "127.0.0.1"
        port = u.port or 11434
        try:
            with socket.create_connection((host, port), timeout=0.7):
                pass
        except OSError:
            return False
        # Daemon is up; quickly check that the requested model tag exists.
        try:
            tags = self._client.list()
            models = tags.get("models", []) if isinstance(tags, dict) else getattr(tags, "models", [])
            wanted = self.model.split(":")[0]
            for m in models:
                name = m.get("name", "") if isinstance(m, dict) else getattr(m, "name", getattr(m, "model", ""))
                if name.startswith(wanted):
                    return True
            # Tag missing but daemon reachable - return True so the toolbar
            # surfaces a clearer error from the model invocation, not "not configured".
            return True
        except Exception:
            return False

    def warmup(self) -> None:
        try:
            self._client.chat(
                model=self.model,
                messages=[{"role": "user", "content": "ok"}],
                options={"num_predict": 1},
            )
        except Exception as exc:
            raise TeacherError(f"warmup failed: {exc}")

    async def stream_lesson(
        self,
        png_bytes: bytes,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        """Stream the model's text response to the multimodal prompt.

        Yields raw text deltas as they arrive. The caller is responsible for
        incremental parsing (see parser.IncrementalTagParser).

        Uses ``ollama.chat()`` (chat-completion API) rather than
        ``ollama.generate()`` because Gemma 4 is chat-tuned and respects the
        system role far more reliably through the chat endpoint.

        `system_prefix` is prepended to the cached system prompt for THIS
        call only (used by the learner module to inject the user's mastery
        state). Concurrent calls don't bleed into each other.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt
        b64_image = base64.b64encode(png_bytes).decode("ascii")

        def producer() -> None:
            try:
                messages = [
                    {"role": "system", "content": system},
                    {
                        "role": "user",
                        "content": self._user_prompt(),
                        "images": [b64_image],
                    },
                ]
                # One guarded continuation prevents a response that hit a
                # provider stop/length boundary from silently losing the last
                # algebraic term. The control marker is consumed by the parser
                # and is never rendered on the board.
                for attempt in range(2):
                    raw_chunks: list[str] = []
                    stream = self._client.chat(
                        model=self.model,
                        messages=messages,
                        stream=True,
                        options={
                            "temperature": 0.2,
                            "num_predict": 4096 if attempt == 0 else 1536,
                        },
                    )
                    for chunk in stream:
                        msg = chunk.get("message", {})
                        text = msg.get("content", "")
                        if text:
                            raw_chunks.append(text)
                            loop.call_soon_threadsafe(queue.put_nowait, text)
                        if chunk.get("done"):
                            break
                    raw = "".join(raw_chunks)
                    if _lesson_is_complete(raw):
                        break
                    messages.extend([
                        {"role": "assistant", "content": raw},
                        {
                            "role": "user",
                            "content": (
                                "The lesson ended before its completion marker. Continue from the "
                                "exact mathematical point reached. Finish every remaining term, "
                                "show the combined final result, then emit [lesson_complete]. "
                                "Do not repeat tags that are already complete."
                            ),
                        },
                    ])
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, f"\n[error: {exc}]")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer_future = loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await producer_future

    def _user_prompt(self) -> str:
        return (
            "The attached image is a snapshot of an Excalidraw whiteboard a student is working on. "
            "Locate the question mark '?' on the canvas: that is what the student wants you to explain. "
            "Read everything they have written, then teach the answer like a teacher at the board.\n\n"
            "Reminders (the system prompt is the full source of truth):\n"
            "- Read the problem exactly: keep integral/sum limits, exponents, subscripts, signs, units.\n"
            "- Limits present => DEFINITE (substitute both limits and subtract); none => INDEFINITE (add + C).\n"
            "- Restate the exact problem in your first tag, then solve fully to a final value; never stop at the antiderivative.\n"
            "- Whiteboard captions, not paragraphs. Aim for 6-12 words per [text: \"...\"].\n"
            "- Math ONLY inside [equation: \"...\"]. NEVER inline $math$ or \\(math\\) in [text:] or [title:].\n"
            "- No markdown (**bold**, _italic_, backticks, headers, bullets) anywhere.\n"
            "- Substitute numbers step by step, one [equation: \"...\"] per step.\n"
            "- 8-15 tags is the target. Hard cap at 30. End with one [text: \"...\"] stating the answer.\n"
            "\nBegin the lesson now."
        )

    async def educator_notes(self, png_bytes: bytes, lesson_text: str = "") -> dict:
        """Fire a second, lightweight Gemma call asking for an educator JSON
        (misconceptions / follow_ups / prereqs / difficulty). Returns the
        parsed JSON dict, or an empty-shaped fallback if the model emits
        something unparsable. Best-effort.
        """
        loop = asyncio.get_running_loop()
        b64_image = base64.b64encode(png_bytes).decode("ascii")

        def producer() -> str:
            try:
                resp = self._client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": EDUCATOR_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": (
                                "Look at the attached whiteboard image and produce educator notes.\n\n"
                                + (f"Lesson the tutor just gave:\n{lesson_text}\n\n" if lesson_text else "")
                                + "Output ONLY valid JSON, nothing else."
                            ),
                            "images": [b64_image],
                        },
                    ],
                    stream=False,
                    options={"temperature": 0.3, "num_predict": 512},
                )
                msg = resp.get("message", {})
                return str(msg.get("content", ""))
            except Exception as exc:
                return f"__error__:{exc}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            raise TeacherError(raw[len("__error__:"):])
        return _parse_educator_json(raw)

    async def extract_evidence(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        safety_identifier: str = "",
    ) -> dict:
        loop = asyncio.get_running_loop()
        b64_image = base64.b64encode(png_bytes).decode("ascii")

        def producer() -> str:
            try:
                response = self._client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": EVIDENCE_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": (
                                "Checkpoint and rubric:\n"
                                + json.dumps(checkpoint, ensure_ascii=False)
                                + "\nGrade the attached learner answer. Output JSON only."
                            ),
                            "images": [b64_image],
                        },
                    ],
                    stream=False,
                    options={"temperature": 0.1, "num_predict": 600},
                )
                return str(response.get("message", {}).get("content", ""))
            except Exception as exc:
                return f"__error__:{exc}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            raise TeacherError(raw[len("__error__:"):])
        return _parse_json_object(raw)

    async def generate_checkpoint(
        self,
        lesson_text: str,
        learner_state: dict,
        conversation_id: str,
        safety_identifier: str = "",
    ) -> dict:
        loop = asyncio.get_running_loop()

        def producer() -> str:
            try:
                response = self._client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": CHECKPOINT_SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": (
                                f"Lesson:\n{lesson_text[-5000:]}\n\n"
                                f"Learner state:\n{learner_state.get('profile_text', '')}\n"
                                "Output JSON only."
                            ),
                        },
                    ],
                    stream=False,
                    options={"temperature": 0.2, "num_predict": 350},
                )
                return str(response.get("message", {}).get("content", ""))
            except Exception as exc:
                return f"__error__:{exc}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            raise TeacherError(raw[len("__error__:"):])
        return _coerce_checkpoint(_parse_json_object(raw), conversation_id)

    async def stream_assessment_feedback(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        evidence: dict,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt
        prompt = (
            ASSESSMENT_FEEDBACK_PROMPT
            + "\n\nCheckpoint:\n" + json.dumps(checkpoint, ensure_ascii=False)
            + "\n\nGrading evidence:\n" + json.dumps(evidence, ensure_ascii=False)
        )
        b64_image = base64.b64encode(png_bytes).decode("ascii")

        def producer() -> None:
            try:
                stream = self._client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt, "images": [b64_image]},
                    ],
                    stream=True,
                    options={"temperature": 0.2, "num_predict": 1200},
                )
                for chunk in stream:
                    text = chunk.get("message", {}).get("content", "")
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
                    if chunk.get("done"):
                        break
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, f"\n[error: {exc}]")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer_future = loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await producer_future

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        learner_context: str = "",
        lesson_context: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        """Stream a text-only tutoring turn through the selected local model."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        chat_messages = [
            {"role": "system", "content": _chat_instructions(learner_context, lesson_context)},
            *messages,
        ]

        def producer() -> None:
            try:
                stream = self._client.chat(
                    model=self.model,
                    messages=chat_messages,
                    stream=True,
                    options={"temperature": 0.3, "num_predict": 1600},
                )
                for chunk in stream:
                    text = chunk.get("message", {}).get("content", "")
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
                    if chunk.get("done"):
                        break
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, f"\n\nChat failed: {exc}")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer_future = loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await producer_future


def _parse_json_object(raw: str) -> dict:
    """Salvage the first balanced JSON object from a model response."""
    if not raw:
        return {}
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    while start >= 0:
        depth = 0
        in_string = False
        escaped = False
        for end in range(start, len(cleaned)):
            ch = cleaned[end]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(cleaned[start:end + 1])
                        return value if isinstance(value, dict) else {}
                    except json.JSONDecodeError:
                        break
        start = cleaned.find("{", start + 1)
    return {}


def _coerce_checkpoint(value: object, conversation_id: str) -> dict:
    source = value if isinstance(value, dict) else {}
    question = re.sub(r"\s+", " ", str(source.get("question", ""))).strip()[:500]
    concepts = source.get("concepts") or []
    if isinstance(concepts, str):
        concepts = [concepts]
    difficulty = str(source.get("difficulty", "introductory")).strip().lower()
    if difficulty not in {"introductory", "intermediate", "transfer"}:
        difficulty = "introductory"
    return {
        "conversation_id": conversation_id,
        "question": question or "Explain the key idea from this lesson in your own words.",
        "concepts": [str(item).strip()[:80] for item in concepts if str(item).strip()][:6],
        "rubric": re.sub(r"\s+", " ", str(source.get("rubric", ""))).strip()[:1000]
        or "The answer should accurately state and apply the lesson's central idea.",
        "difficulty": difficulty,
    }


def _parse_educator_json(raw: str) -> dict:
    """Parse the educator-notes JSON the model emits, with a salvage step.

    Models occasionally wrap JSON in code fences or add a leading sentence.
    We look for the first balanced {...} block and parse that. If no balanced
    block can be found we return an empty-shaped dict so the frontend has
    something to render instead of failing the lesson.
    """
    return _coerce_shape(_parse_json_object(raw))


def _coerce_shape(d: object) -> dict:
    """Normalise the parsed object to the expected schema."""
    if not isinstance(d, dict):
        return {"misconceptions": [], "follow_ups": [], "prereqs": [], "difficulty": ""}
    out = {
        "misconceptions": _as_str_list(d.get("misconceptions")),
        "follow_ups": _as_str_list(d.get("follow_ups") or d.get("follow_up_questions")),
        "prereqs": _as_str_list(d.get("prereqs") or d.get("prerequisites")),
        "difficulty": str(d.get("difficulty", "")).strip(),
    }
    return out


def _as_str_list(v: object) -> list[str]:
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str):
        return [v.strip()]
    return []


# ---------------------------------------------------------------------------
# CloudTeacher (Google AI Studio · Gemma 4 31B)
# ---------------------------------------------------------------------------

CLOUD_DEFAULT_MODEL = "gemma-4-31b-it"


def _normalise_cloud_model(name: str) -> str:
    """Normalise a Gemma cloud model id.

    The Google GenAI SDK 2.0.1 has a known bug where Gemma model IDs sometimes
    require a ``models/`` prefix (legacy v1beta endpoint) and sometimes don't
    (newer 2.x endpoint). We accept either form from the user, and from
    `os.environ`, and pass through whatever they give us. The runtime error
    surface is tiny — if Gemini misbehaves, the ``[cloud error: ...]`` token
    in the SSE stream tells the user to flip the prefix.
    """
    name = (name or "").strip()
    if not name:
        return CLOUD_DEFAULT_MODEL
    return name


class CloudTeacher:
    """Cloud variant routed through Google AI Studio's Gemma 4 31B endpoint.

    Implementation notes:
      * Prefers the modern ``google-genai`` package with ``client.aio`` for
        natural async streaming. Falls back to the legacy
        ``google-generativeai`` if only that one is installed.
      * Accepts a multimodal whiteboard PNG via ``types.Part.from_bytes``.
      * Honours ``system_instruction`` (Gemma 4 supports system role natively
        now, unlike Gemma 3).
      * If the API key isn't configured, every method raises
        :class:`TeacherError` with a clear message so the SSE error event
        explains exactly what to do (rather than hanging).
      * Errors are categorised: 401/permission denied -> "API key invalid";
        429/rate limit -> "rate limit, slow down"; 404 -> "model not found
        (try toggling the models/ prefix)".

    For provisioning details see ``.env.example`` and ``models/README.md``.
    """

    def __init__(self, model: str | None = None, api_key: str | None = None) -> None:
        self.model = _normalise_cloud_model(model or os.environ.get("CLOUD_MODEL", ""))
        self.host = "https://generativelanguage.googleapis.com"
        self._api_key = (api_key or os.environ.get("GOOGLE_API_KEY", "")).strip()
        self._system_prompt = _load_system_prompt()
        self._client = None  # genai client (preferred) or legacy module
        self._client_kind: str | None = None  # "genai" | "legacy"

    # --- helpers ---------------------------------------------------------

    def _ensure_client(self) -> None:
        if self._client is not None:
            return
        if not self._api_key:
            raise TeacherError(
                "GOOGLE_API_KEY is not set. Add it to .env (or pick the Edge "
                "model in the toolbar)."
            )
        # Prefer the modern SDK; fall back to the legacy one if missing.
        try:
            from google import genai  # type: ignore

            self._client = genai.Client(api_key=self._api_key)
            self._client_kind = "genai"
            return
        except Exception:
            pass
        try:
            import google.generativeai as legacy_genai  # type: ignore

            legacy_genai.configure(api_key=self._api_key)
            self._client = legacy_genai
            self._client_kind = "legacy"
            return
        except Exception as exc:  # pragma: no cover - import guard
            raise TeacherError(
                "Neither `google-genai` nor `google-generativeai` is installed. "
                "Add `google-genai` to api/pyproject.toml (`uv add google-genai`)."
            ) from exc

    @staticmethod
    def _classify_error(exc: BaseException) -> str:
        """Map common Gemini SDK errors to a one-line, user-actionable hint."""
        msg = str(exc)
        low = msg.lower()
        if "401" in low or "permission" in low or "api key" in low or "unauthenticated" in low:
            return "GOOGLE_API_KEY is missing, invalid, or lacks Gemma 4 access."
        if "429" in low or "rate" in low and "limit" in low or "quota" in low:
            return "Rate-limited by Google AI Studio. Wait a few seconds and retry."
        if "404" in low or "not found" in low:
            return (
                f"Model `{msg if 'gemma' in low else ''}` not found. Try toggling the "
                "`models/` prefix on CLOUD_MODEL, e.g. `models/gemma-4-31b-it`."
            )
        if "deadline" in low or "timeout" in low:
            return "Cloud request timed out. Try again or fall back to Edge."
        return msg

    # --- protocol surface -----------------------------------------------

    def ping(self) -> bool:
        return bool(self._api_key)

    def warmup(self) -> None:
        # Cloud has no warmup cost we want to trigger eagerly (it costs a
        # token); just verify creds resolve so a misconfiguration surfaces
        # immediately on startup.
        if not self._api_key:
            return  # silent: cloud is opt-in
        try:
            self._ensure_client()
        except Exception as exc:
            raise TeacherError(f"cloud warmup failed: {self._classify_error(exc)}")

    async def stream_lesson(
        self,
        png_bytes: bytes,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        """Stream Gemma-4-31B output asynchronously."""
        self._ensure_client()
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt
        user_text = self._user_prompt()

        if self._client_kind == "genai":
            from google.genai import types  # type: ignore

            client = self._client  # genai.Client
            try:
                stream = await client.aio.models.generate_content_stream(  # type: ignore[union-attr]
                    model=self.model,
                    contents=[
                        types.Content(
                            role="user",
                            parts=[
                                types.Part.from_text(text=user_text),
                                types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                            ],
                        )
                    ],
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        temperature=0.4,
                        max_output_tokens=4096,
                    ),
                )
            except Exception as exc:
                yield f"\n[cloud error: {self._classify_error(exc)}]"
                return
            try:
                async for chunk in stream:
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        yield text
            except Exception as exc:
                yield f"\n[cloud error: {self._classify_error(exc)}]"
            return

        # Legacy SDK fallback: synchronous stream marshalled through a queue.
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        legacy_client = self._client
        model_id = self.model

        def producer() -> None:
            try:
                model = legacy_client.GenerativeModel(  # type: ignore[union-attr]
                    model_id, system_instruction=system,
                )
                resp = model.generate_content(
                    [user_text, {"mime_type": "image/png", "data": png_bytes}],
                    stream=True,
                )
                for chunk in resp:
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                loop.call_soon_threadsafe(
                    queue.put_nowait, f"\n[cloud error: {self._classify_error(exc)}]"
                )
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer_future = loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await producer_future

    def _user_prompt(self) -> str:
        return (
            "The attached image is a snapshot of an Excalidraw whiteboard a student is working on. "
            "Locate the question mark '?' on the canvas: that is what the student wants you to explain. "
            "Read everything they have written, then teach the answer like a teacher at the board.\n\n"
            "Reminders (the system prompt is the full source of truth):\n"
            "- Read the problem exactly: keep integral/sum limits, exponents, subscripts, signs, units.\n"
            "- Limits present => DEFINITE (substitute both limits and subtract); none => INDEFINITE (add + C).\n"
            "- Restate the exact problem in your first tag, then solve fully to a final value; never stop at the antiderivative.\n"
            "- Whiteboard captions, not paragraphs. Aim for 6-12 words per [text: \"...\"].\n"
            "- Math ONLY inside [equation: \"...\"]. NEVER inline $math$ or \\(math\\) in [text:] or [title:].\n"
            "- No markdown anywhere.\n"
            "- 8-15 tags. Hard cap at 30. End with one [text: \"...\"] stating the answer.\n"
            "\nBegin the lesson now."
        )

    async def educator_notes(self, png_bytes: bytes, lesson_text: str = "") -> dict:
        """Run the educator-notes pass via Gemma 4 31B."""
        self._ensure_client()
        prompt_body = (
            "Look at the attached whiteboard image and produce educator notes.\n\n"
            + (f"Lesson the tutor just gave:\n{lesson_text}\n\n" if lesson_text else "")
            + "Output ONLY valid JSON, nothing else."
        )

        if self._client_kind == "genai":
            from google.genai import types  # type: ignore

            client = self._client
            try:
                resp = await client.aio.models.generate_content(  # type: ignore[union-attr]
                    model=self.model,
                    contents=[
                        types.Content(
                            role="user",
                            parts=[
                                types.Part.from_text(text=prompt_body),
                                types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                            ],
                        )
                    ],
                    config=types.GenerateContentConfig(
                        system_instruction=EDUCATOR_SYSTEM_PROMPT,
                        temperature=0.3,
                        max_output_tokens=512,
                    ),
                )
            except Exception as exc:
                raise TeacherError(self._classify_error(exc))
            raw = getattr(resp, "text", "") or ""
            return _parse_educator_json(raw)

        # Legacy fallback.
        loop = asyncio.get_running_loop()
        legacy_client = self._client
        model_id = self.model

        def producer() -> str:
            try:
                model = legacy_client.GenerativeModel(  # type: ignore[union-attr]
                    model_id, system_instruction=EDUCATOR_SYSTEM_PROMPT,
                )
                resp = model.generate_content(
                    [prompt_body, {"mime_type": "image/png", "data": png_bytes}],
                )
                return getattr(resp, "text", "") or ""
            except Exception as exc:
                return f"__error__:{self._classify_error(exc)}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            raise TeacherError(raw[len("__error__:"):])
        return _parse_educator_json(raw)


    async def _json_request(
        self,
        system: str,
        prompt: str,
        png_bytes: bytes | None = None,
    ) -> dict:
        self._ensure_client()
        if self._client_kind == "genai":
            from google.genai import types  # type: ignore

            parts = [types.Part.from_text(text=prompt)]
            if png_bytes is not None:
                parts.append(types.Part.from_bytes(data=png_bytes, mime_type="image/png"))
            try:
                response = await self._client.aio.models.generate_content(  # type: ignore[union-attr]
                    model=self.model,
                    contents=[types.Content(role="user", parts=parts)],
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        temperature=0.1,
                        max_output_tokens=700,
                    ),
                )
            except Exception as exc:
                raise TeacherError(self._classify_error(exc)) from exc
            return _parse_json_object(getattr(response, "text", "") or "")

        loop = asyncio.get_running_loop()
        legacy_client = self._client

        def producer() -> str:
            try:
                model = legacy_client.GenerativeModel(  # type: ignore[union-attr]
                    self.model, system_instruction=system,
                )
                content: list[object] = [prompt]
                if png_bytes is not None:
                    content.append({"mime_type": "image/png", "data": png_bytes})
                response = model.generate_content(content)
                return getattr(response, "text", "") or ""
            except Exception as exc:
                return f"__error__:{self._classify_error(exc)}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            raise TeacherError(raw[len("__error__:"):])
        return _parse_json_object(raw)

    async def extract_evidence(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        safety_identifier: str = "",
    ) -> dict:
        return await self._json_request(
            EVIDENCE_SYSTEM_PROMPT,
            "Checkpoint and rubric:\n"
            + json.dumps(checkpoint, ensure_ascii=False)
            + "\nGrade the attached answer. Output JSON only.",
            png_bytes,
        )

    async def generate_checkpoint(
        self,
        lesson_text: str,
        learner_state: dict,
        conversation_id: str,
        safety_identifier: str = "",
    ) -> dict:
        value = await self._json_request(
            CHECKPOINT_SYSTEM_PROMPT,
            f"Lesson:\n{lesson_text[-5000:]}\n\n"
            f"Learner state:\n{learner_state.get('profile_text', '')}\n"
            "Output JSON only.",
        )
        return _coerce_checkpoint(value, conversation_id)

    async def stream_assessment_feedback(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        evidence: dict,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        self._ensure_client()
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt
        prompt = (
            ASSESSMENT_FEEDBACK_PROMPT
            + "\n\nCheckpoint:\n" + json.dumps(checkpoint, ensure_ascii=False)
            + "\n\nGrading evidence:\n" + json.dumps(evidence, ensure_ascii=False)
        )
        if self._client_kind == "genai":
            from google.genai import types  # type: ignore

            try:
                stream = await self._client.aio.models.generate_content_stream(  # type: ignore[union-attr]
                    model=self.model,
                    contents=[types.Content(role="user", parts=[
                        types.Part.from_text(text=prompt),
                        types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                    ])],
                    config=types.GenerateContentConfig(
                        system_instruction=system,
                        temperature=0.2,
                        max_output_tokens=1200,
                    ),
                )
                async for chunk in stream:
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        yield text
            except Exception as exc:
                raise TeacherError(self._classify_error(exc)) from exc
            return

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        legacy_client = self._client

        def producer() -> None:
            try:
                model = legacy_client.GenerativeModel(  # type: ignore[union-attr]
                    self.model, system_instruction=system,
                )
                response = model.generate_content(
                    [prompt, {"mime_type": "image/png", "data": png_bytes}],
                    stream=True,
                )
                for chunk in response:
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, f"\n[cloud error: {exc}]")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer_future = loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await producer_future

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        learner_context: str = "",
        lesson_context: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        self._ensure_client()
        instructions = _chat_instructions(learner_context, lesson_context)

        # Flattening the short role-labelled exchange keeps this path
        # compatible with both the modern and legacy Google SDKs.
        transcript = "\n\n".join(
            f"{'Learner' if item['role'] == 'user' else 'Tutor'}: {item['content']}"
            for item in messages
        )
        prompt = transcript + "\n\nTutor:"
        if self._client_kind == "genai":
            from google.genai import types  # type: ignore

            try:
                stream = await self._client.aio.models.generate_content_stream(  # type: ignore[union-attr]
                    model=self.model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=instructions,
                        temperature=0.3,
                        max_output_tokens=1600,
                    ),
                )
                async for chunk in stream:
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        yield text
            except Exception as exc:
                raise TeacherError(self._classify_error(exc)) from exc
            return

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        legacy_client = self._client

        def producer() -> None:
            try:
                model = legacy_client.GenerativeModel(  # type: ignore[union-attr]
                    self.model, system_instruction=instructions,
                )
                response = model.generate_content(prompt, stream=True)
                for chunk in response:
                    text = getattr(chunk, "text", "") or ""
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, f"\n\nChat failed: {exc}")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer_future = loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
        await producer_future


# ---------------------------------------------------------------------------
# OpenAITeacher (GPT-5.6 Responses API)
# ---------------------------------------------------------------------------


class OpenAITeacher:
    """GPT-5.6 vision teacher with a cheaper structured-analysis path."""

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        evidence_model: str | None = None,
    ) -> None:
        self.model = model or os.environ.get("OPENAI_MODEL", "gpt-5.6-sol")
        self.evidence_model = evidence_model or os.environ.get(
            "OPENAI_EVIDENCE_MODEL", "gpt-5.6-terra"
        )
        self.host = "https://api.openai.com"
        self._api_key = (api_key or os.environ.get("OPENAI_API_KEY", "")).strip()
        self._system_prompt = _load_system_prompt()
        self._client = None

    def _ensure_client(self):
        if self._client is not None:
            return self._client
        if not self._api_key:
            raise TeacherError(
                "OPENAI_API_KEY is not set. Add it to .env or choose Local Gemma."
            )
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover - installation guard
            raise TeacherError("Install the `openai` Python package.") from exc
        self._client = AsyncOpenAI(api_key=self._api_key)
        return self._client

    def ping(self) -> bool:
        return bool(self._api_key)

    def warmup(self) -> None:
        # Avoid a billable request at startup; readiness means credentials exist.
        if self._api_key:
            self._ensure_client()

    @staticmethod
    def _image_input(png_bytes: bytes, prompt: str) -> list[dict]:
        image = base64.b64encode(png_bytes).decode("ascii")
        return [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {
                    "type": "input_image",
                    "image_url": f"data:image/png;base64,{image}",
                    "detail": "original",
                },
            ],
        }]

    @staticmethod
    def _safety_kwargs(safety_identifier: str) -> dict:
        return {"safety_identifier": safety_identifier} if safety_identifier else {}

    async def _stream_response(
        self,
        *,
        png_bytes: bytes,
        instructions: str,
        prompt: str,
        safety_identifier: str,
        reasoning_effort: str = "medium",
    ) -> AsyncIterator[str]:
        client = self._ensure_client()
        try:
            stream = await client.responses.create(
                model=self.model,
                instructions=instructions,
                input=self._image_input(png_bytes, prompt),
                reasoning={"effort": reasoning_effort},
                store=False,
                stream=True,
                **self._safety_kwargs(safety_identifier),
            )
            async for event in stream:
                if getattr(event, "type", "") == "response.output_text.delta":
                    delta = getattr(event, "delta", "") or ""
                    if delta:
                        yield delta
        except Exception as exc:
            raise TeacherError(f"OpenAI request failed: {exc}") from exc

    async def _json_response(
        self,
        *,
        instructions: str,
        prompt: str,
        png_bytes: bytes | None = None,
        safety_identifier: str = "",
    ) -> dict:
        client = self._ensure_client()
        input_value: object
        if png_bytes is None:
            input_value = prompt
        else:
            input_value = self._image_input(png_bytes, prompt)
        try:
            response = await client.responses.create(
                model=self.evidence_model,
                instructions=instructions,
                input=input_value,
                reasoning={"effort": "low"},
                store=False,
                **self._safety_kwargs(safety_identifier),
            )
        except Exception as exc:
            raise TeacherError(f"OpenAI analysis failed: {exc}") from exc
        return _parse_json_object(getattr(response, "output_text", "") or "")

    async def stream_lesson(
        self,
        png_bytes: bytes,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt
        prompt = (
            "Read the attached Excalidraw whiteboard and locate the learner's question mark. "
            "Read the problem exactly -- keep integral/sum limits, exponents, subscripts, signs, and units; "
            "an integral with limits is definite (substitute both limits and subtract), without limits it is "
            "indefinite (add + C). Restate the exact problem in your first tag, then solve it fully to a final "
            "value; never stop at the antiderivative. Teach the missing idea on the same board. Emit only the "
            "primitive protocol: short captions, math only in equation tags, 8-15 tags, and no markdown."
        )
        async for delta in self._stream_response(
            png_bytes=png_bytes,
            instructions=system,
            prompt=prompt,
            safety_identifier=safety_identifier,
        ):
            yield delta

    async def educator_notes(self, png_bytes: bytes, lesson_text: str = "") -> dict:
        value = await self._json_response(
            instructions=EDUCATOR_SYSTEM_PROMPT,
            prompt=(
                "Produce educator notes for the attached board.\n\n"
                + (f"Lesson:\n{lesson_text[-5000:]}\n" if lesson_text else "")
                + "Output JSON only."
            ),
            png_bytes=png_bytes,
        )
        return _coerce_shape(value)

    async def extract_evidence(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        safety_identifier: str = "",
    ) -> dict:
        return await self._json_response(
            instructions=EVIDENCE_SYSTEM_PROMPT,
            prompt=(
                "Checkpoint and rubric:\n"
                + json.dumps(checkpoint, ensure_ascii=False)
                + "\nGrade the attached answer. Output JSON only."
            ),
            png_bytes=png_bytes,
            safety_identifier=safety_identifier,
        )

    async def generate_checkpoint(
        self,
        lesson_text: str,
        learner_state: dict,
        conversation_id: str,
        safety_identifier: str = "",
    ) -> dict:
        value = await self._json_response(
            instructions=CHECKPOINT_SYSTEM_PROMPT,
            prompt=(
                f"Lesson:\n{lesson_text[-5000:]}\n\n"
                f"Learner state:\n{learner_state.get('profile_text', '')}\n"
                "Output JSON only."
            ),
            safety_identifier=safety_identifier,
        )
        return _coerce_checkpoint(value, conversation_id)

    async def stream_assessment_feedback(
        self,
        png_bytes: bytes,
        checkpoint: dict,
        evidence: dict,
        system_prefix: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt
        prompt = (
            ASSESSMENT_FEEDBACK_PROMPT
            + "\n\nCheckpoint:\n" + json.dumps(checkpoint, ensure_ascii=False)
            + "\n\nGrading evidence:\n" + json.dumps(evidence, ensure_ascii=False)
        )
        async for delta in self._stream_response(
            png_bytes=png_bytes,
            instructions=system,
            prompt=prompt,
            safety_identifier=safety_identifier,
            reasoning_effort="low",
        ):
            yield delta

    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        learner_context: str = "",
        lesson_context: str = "",
        safety_identifier: str = "",
    ) -> AsyncIterator[str]:
        client = self._ensure_client()
        try:
            stream = await client.responses.create(
                model=self.model,
                instructions=_chat_instructions(learner_context, lesson_context),
                input=messages,
                reasoning={"effort": "low"},
                store=False,
                stream=True,
                **self._safety_kwargs(safety_identifier),
            )
            async for event in stream:
                if getattr(event, "type", "") == "response.output_text.delta":
                    delta = getattr(event, "delta", "") or ""
                    if delta:
                        yield delta
        except Exception as exc:
            raise TeacherError(f"OpenAI chat failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

# Maps the toolbar's `model_choice` to a provider and model.
ModelChoice = str  # "openai" | "edge" | "edge-ft" | "cloud"

DEFAULT_OLLAMA_HOST = "http://localhost:11434"

MODEL_REGISTRY: dict[str, dict[str, str]] = {
    "openai": {
        "kind": "openai",
        "model": os.environ.get("OPENAI_MODEL", "gpt-5.6-sol"),
    },
    "edge": {
        "kind": "ollama",
        "model": os.environ.get("MODEL_NAME", "gemma4:e4b"),
    },
    "edge-ft": {
        "kind": "ollama",
        # Overridable via env so the user can switch to a different fine-tuned
        # tag without redeploying the API.
        "model": os.environ.get("MODEL_NAME_EDGE_FT", "y-gemma4"),
    },
    "cloud": {
        "kind": "cloud",
        "model": os.environ.get("CLOUD_MODEL", CLOUD_DEFAULT_MODEL),
    },
}


_teacher_cache: dict[str, Teacher] = {}


def resolve_teacher(choice: ModelChoice) -> Teacher:
    """Return a (cached) Teacher instance for the given toolbar choice.

    Falls back to the "edge" entry if the choice isn't recognised; this keeps
    the lesson endpoint resilient against frontend/backend version skew.
    """
    cfg = MODEL_REGISTRY.get(choice) or MODEL_REGISTRY["edge"]
    cache_key = f"{cfg['kind']}:{cfg['model']}"
    if cache_key in _teacher_cache:
        return _teacher_cache[cache_key]
    teacher: Teacher
    if cfg["kind"] == "openai":
        teacher = OpenAITeacher(model=cfg["model"])
    elif cfg["kind"] == "cloud":
        teacher = CloudTeacher(model=cfg["model"])
    else:
        teacher = OllamaTeacher(
            host=os.environ.get("OLLAMA_HOST", DEFAULT_OLLAMA_HOST),
            model=cfg["model"],
        )
    _teacher_cache[cache_key] = teacher
    return teacher
