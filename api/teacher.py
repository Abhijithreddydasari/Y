"""Teacher: abstraction over the LLM that emits lessons.

Two concrete implementations:

  * ``OllamaTeacher`` — local Ollama daemon serving any pulled Gemma 4 / 3n
    variant (``gemma4:e4b``, ``y-gemma4`` after the LoRA-merged Modelfile is
    built, etc.). Default in dev.
  * ``CloudTeacher`` — Google AI Studio (Gemma 4 31B). High-quality demo
    button. Currently a thin wrapper; P9 of the plan finishes it.

The toolbar's "Edge / Edge fine-tuned / Cloud" dropdown maps directly to
:func:`get_teacher`.
"""
from __future__ import annotations

import asyncio
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
        self, png_bytes: bytes, system_prefix: str = ""
    ) -> AsyncIterator[str]: ...

    async def educator_notes(self, png_bytes: bytes, lesson_text: str = "") -> dict: ...


PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"

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


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _load_system_prompt() -> str:
    """Concatenate system.md + primitives.md + every prompts/examples/*.md as few-shots.

    Layout:
        [system.md]
        ---
        [primitives.md]   (already has its own header)
        ---
        # Few-shot examples
        [examples/*.md]   (joined; each file already has its own header)
    """
    parts: list[str] = [_read(PROMPTS_DIR / "system.md"), "\n\n---\n\n", _read(PROMPTS_DIR / "primitives.md")]
    examples_dir = PROMPTS_DIR / "examples"
    if examples_dir.is_dir():
        examples = sorted(examples_dir.glob("*.md"))
        if examples:
            parts.append("\n\n---\n\n# Few-shot examples\n\nThese show the exact output format expected. Always follow this style.\n")
            for ex in examples:
                parts.append("\n\n")
                parts.append(_read(ex))
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
            self._client.generate(model=self.model, prompt="ok", options={"num_predict": 1})
        except Exception as exc:
            raise TeacherError(f"warmup failed: {exc}")

    async def stream_lesson(
        self,
        png_bytes: bytes,
        system_prefix: str = "",
    ) -> AsyncIterator[str]:
        """Stream the model's text response to the multimodal prompt.

        Yields raw text deltas as they arrive. The caller is responsible for
        incremental parsing (see parser.IncrementalTagParser).

        `system_prefix` is prepended to the cached system prompt for THIS
        call only (used by the learner module to inject the user's mastery
        state). Concurrent calls don't bleed into each other.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        system = (system_prefix + self._system_prompt) if system_prefix else self._system_prompt

        def producer() -> None:
            try:
                stream = self._client.generate(
                    model=self.model,
                    prompt=self._user_prompt(),
                    system=system,
                    images=[png_bytes],
                    stream=True,
                    options={
                        "temperature": 0.4,
                        "num_predict": 2048,
                    },
                )
                for chunk in stream:
                    text = chunk.get("response", "")
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
                    if chunk.get("done"):
                        break
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, f"\n[error: {exc}]")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        await loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                return
            yield item

    def _user_prompt(self) -> str:
        return (
            "The attached image is a snapshot of an Excalidraw whiteboard a student is working on. "
            "Locate the question mark '?' on the canvas: that is what the student wants you to explain. "
            "Read everything they have written, then teach the answer like a teacher at the board.\n\n"
            "Reminders (the system prompt is the full source of truth):\n"
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

        def producer() -> str:
            try:
                resp = self._client.generate(
                    model=self.model,
                    prompt=(
                        "Look at the attached whiteboard image and produce educator notes.\n\n"
                        + (f"Lesson the tutor just gave:\n{lesson_text}\n\n" if lesson_text else "")
                        + "Output ONLY valid JSON, nothing else."
                    ),
                    system=EDUCATOR_SYSTEM_PROMPT,
                    images=[png_bytes],
                    stream=False,
                    options={"temperature": 0.3, "num_predict": 512},
                )
                return str(resp.get("response", ""))
            except Exception as exc:
                return f"__error__:{exc}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            raise TeacherError(raw[len("__error__:"):])
        return _parse_educator_json(raw)


def _parse_educator_json(raw: str) -> dict:
    """Parse the educator-notes JSON the model emits, with a salvage step.

    Models occasionally wrap JSON in code fences or add a leading sentence.
    We look for the first balanced {...} block and parse that. If no balanced
    block can be found we return an empty-shaped dict so the frontend has
    something to render instead of failing the lesson.
    """
    fallback = {"misconceptions": [], "follow_ups": [], "prereqs": [], "difficulty": ""}
    if not raw:
        return fallback
    # Try the cleanest path first.
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return _coerce_shape(json.loads(cleaned))
    except json.JSONDecodeError:
        pass
    # Salvage: scan for the first balanced {...}.
    start = cleaned.find("{")
    while start != -1:
        depth = 0
        for end in range(start, len(cleaned)):
            ch = cleaned[end]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    chunk = cleaned[start:end + 1]
                    try:
                        return _coerce_shape(json.loads(chunk))
                    except json.JSONDecodeError:
                        break
        start = cleaned.find("{", start + 1)
    return fallback


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
        self, png_bytes: bytes, system_prefix: str = ""
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
                        max_output_tokens=2048,
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

        await loop.run_in_executor(None, producer)
        while True:
            item = await queue.get()
            if item is None:
                return
            yield item

    def _user_prompt(self) -> str:
        return (
            "The attached image is a snapshot of an Excalidraw whiteboard a student is working on. "
            "Locate the question mark '?' on the canvas: that is what the student wants you to explain. "
            "Read everything they have written, then teach the answer like a teacher at the board.\n\n"
            "Reminders (the system prompt is the full source of truth):\n"
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


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

# Maps the toolbar's `model_choice` to a (kind, ollama-model | cloud-model).
# `kind` is "ollama" or "cloud"; resolve_teacher() picks the constructor.
ModelChoice = str  # "edge" | "edge-ft" | "cloud"

DEFAULT_OLLAMA_HOST = "http://localhost:11434"

MODEL_REGISTRY: dict[str, dict[str, str]] = {
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
    if cfg["kind"] == "cloud":
        teacher: Teacher = CloudTeacher(model=cfg["model"])
    else:
        teacher = OllamaTeacher(
            host=os.environ.get("OLLAMA_HOST", DEFAULT_OLLAMA_HOST),
            model=cfg["model"],
        )
    _teacher_cache[cache_key] = teacher
    return teacher
