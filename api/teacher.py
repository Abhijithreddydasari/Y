"""Teacher: abstraction over the LLM that emits lessons.

Phase 0 uses Gemma 3 via Ollama. The interface is intentionally narrow so that
a swap to Gemma 4 / Google AI Studio / OpenAI is a one-file change.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import AsyncIterator

import ollama


class TeacherError(RuntimeError):
    pass


PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


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
        try:
            self._client.list()
            return True
        except Exception:
            return False

    def warmup(self) -> None:
        try:
            self._client.generate(model=self.model, prompt="ok", options={"num_predict": 1})
        except Exception as exc:
            raise TeacherError(f"warmup failed: {exc}")

    async def stream_lesson(self, png_bytes: bytes) -> AsyncIterator[str]:
        """Stream the model's text response to the multimodal prompt.

        Yields raw text deltas as they arrive. The caller is responsible for
        incremental parsing (see parser.IncrementalTagParser).
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        sentinel: object = object()

        def producer() -> None:
            try:
                stream = self._client.generate(
                    model=self.model,
                    prompt=self._user_prompt(),
                    system=self._system_prompt,
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
            "Read everything they have written, then teach the answer step by step.\n\n"
            "Output rules (HARD):\n"
            "- Use only the primitive tags listed in the system prompt.\n"
            "- One tag per line.\n"
            "- Coordinates are optional; omit them so the layout engine can place automatically.\n"
            "- Wrap natural-language narration as plain text between tags (no tags inside narration).\n"
            "- Do not exceed 30 tags. Stop with a final summary [text: \"...\"].\n"
            "\nBegin the lesson now."
        )
