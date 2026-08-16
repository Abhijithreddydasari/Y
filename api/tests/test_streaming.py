from __future__ import annotations

import asyncio
import time

from parser import IncrementalTagParser
from teacher import OllamaTeacher


def test_completion_marker_is_control_only() -> None:
    parser = IncrementalTagParser()
    events = list(parser.feed(
        '[equation: "x^3 + 2x^2 - 5x + C"]\n[lesson_complete]\n'
    ))
    events.extend(parser.flush())
    primitives = [event["tag"] for event in events if event["event"] == "primitive"]
    tokens = [event["text"] for event in events if event["event"] == "token"]
    assert [item["tag"] for item in primitives] == ["equation"]
    assert "lesson_complete" not in "".join(tokens)


def test_ollama_queue_streams_before_sync_producer_finishes() -> None:
    class FakeClient:
        def chat(self, **kwargs):
            assert kwargs["stream"] is True

            def chunks():
                yield {
                    "message": {"content": '[text: "First visible line"]\n[lesson_complete]'},
                    "done": False,
                }
                time.sleep(0.35)
                yield {"message": {"content": ""}, "done": True}

            return chunks()

    teacher = OllamaTeacher("http://unused", "fake")
    teacher._client = FakeClient()  # type: ignore[assignment]

    async def first_delta() -> tuple[str, float]:
        started = time.perf_counter()
        stream = teacher.stream_lesson(b"png")
        first = await asyncio.wait_for(anext(stream), timeout=0.2)
        await stream.aclose()
        return first, time.perf_counter() - started

    first, elapsed = asyncio.run(first_delta())
    assert "First visible line" in first
    assert elapsed < 0.2
