from __future__ import annotations

import asyncio
from types import SimpleNamespace

from teacher import OpenAITeacher


class FakeStream:
    def __init__(self) -> None:
        self.events = [
            SimpleNamespace(type="response.output_text.delta", delta='[text: "Hi'),
            SimpleNamespace(type="response.output_text.delta", delta=' there"]'),
            SimpleNamespace(type="response.completed", delta=""),
        ]

    def __aiter__(self):
        self.iterator = iter(self.events)
        return self

    async def __anext__(self):
        try:
            return next(self.iterator)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeResponses:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("stream"):
            return FakeStream()
        instructions = kwargs.get("instructions", "")
        if "grading" in instructions.lower():
            text = '{"concepts":[{"name":"fractions"}],"outcome":{"correct":0.8,"partial":0.1,"incorrect":0.1},"independence":0.9,"evidence_strength":0.9,"response_summary":"correct","misconception":""}'
        else:
            text = '{"question":"Try another fraction.","concepts":["fractions"],"rubric":"correct method","difficulty":"transfer"}'
        return SimpleNamespace(output_text=text)


def test_openai_responses_stream_and_structured_paths() -> None:
    teacher = OpenAITeacher(api_key="test-key")
    responses = FakeResponses()
    teacher._client = SimpleNamespace(responses=responses)

    async def run():
        lesson = [part async for part in teacher.stream_lesson(b"png", safety_identifier="y_hashed")]
        evidence = await teacher.extract_evidence(b"png", {"question": "q", "rubric": "r"}, "y_hashed")
        checkpoint = await teacher.generate_checkpoint("lesson", {"profile_text": "uncertain"}, "conv", "y_hashed")
        return lesson, evidence, checkpoint

    lesson, evidence, checkpoint = asyncio.run(run())
    assert "".join(lesson) == '[text: "Hi there"]'
    stream_call = responses.calls[0]
    assert stream_call["model"] == "gpt-5.6-sol"
    assert stream_call["reasoning"] == {"effort": "medium"}
    assert stream_call["store"] is False
    assert stream_call["safety_identifier"] == "y_hashed"
    image = stream_call["input"][0]["content"][1]
    assert image["image_url"].startswith("data:image/png;base64,")
    assert image["detail"] == "original"
    assert evidence["outcome"]["correct"] == 0.8
    assert checkpoint["conversation_id"] == "conv"
    assert responses.calls[1]["model"] == "gpt-5.6-terra"
    assert responses.calls[1]["reasoning"] == {"effort": "low"}
