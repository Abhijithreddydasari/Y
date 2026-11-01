"""Meta tutor adapter: Muse Spark over the OpenAI-compatible chat API, strict-JSON moves, streamed.

The adapter owns transport only: bounded output, timeouts and sanitized error codes. Parsing and
validation live in the turn engine so a mocked adapter exercises the same path.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import AsyncIterator

import httpx

from .decisions import ProviderFailure
from .tutor_moves import response_format
from .tutor_turn import ENABLED

META_BASE = "https://api.meta.ai/v1"
MAX_OUTPUT_TOKENS = 3000  # minimal effort reasons for ~450 tokens; a turn is ~600-1,000 output tokens
MAX_CONTENT_CHARS = 40_000
_FORMAT = response_format(ENABLED)  # constrained decoding cannot emit kinds this slice cannot render


class MetaTutor:
    """One instance per request; the HTTP client is shared by the application."""

    def __init__(self, client: httpx.AsyncClient, api_key: str | None = None, model: str | None = None):
        self.client = client
        self.api_key = (os.environ.get("MODEL_API_KEY", "") if api_key is None else api_key).strip()
        self.model = model or os.environ.get("META_TUTOR_MODEL", "muse-spark-1.3")
        self.effort = "minimal"
        self.usage: dict[str, int] = {}
        self.timing: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _body(self, messages: list[dict], stream: bool, max_tokens: int) -> dict:
        body = {"model": self.model, "reasoning_effort": self.effort, "messages": messages,
                "response_format": _FORMAT, "max_tokens": max_tokens, "stream": stream}
        if stream:
            body["stream_options"] = {"include_usage": True}
        return body

    def _usage(self, value: dict | None) -> None:
        value = value or {}
        details = value.get("prompt_tokens_details") or {}
        reasoning = (value.get("completion_tokens_details") or {}).get("reasoning_tokens")
        for key, amount in (("input_tokens", value.get("prompt_tokens")), ("output_tokens", value.get("completion_tokens")),
                            ("cached_tokens", details.get("cached_tokens")), ("reasoning_tokens", reasoning)):
            if type(amount) is int and amount >= 0:
                self.usage[key] = amount

    async def stream(self, messages: list[dict]) -> AsyncIterator[str]:
        """Yield content deltas of one turn. Raises ProviderFailure with a safe code."""
        if not self.api_key:
            raise ProviderFailure("provider_not_configured")
        started, chars = time.perf_counter(), 0
        try:
            async with self.client.stream("POST", f"{META_BASE}/chat/completions",
                                          json=self._body(messages, True, MAX_OUTPUT_TOKENS),
                                          headers={"Authorization": f"Bearer {self.api_key}"},
                                          timeout=httpx.Timeout(20, connect=5)) as response:
                self.timing["headers_ms"] = (time.perf_counter() - started) * 1000
                if response.status_code != 200:
                    raise ProviderFailure(_status_code(response.status_code))
                finish = None
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    event = json.loads(data)
                    if event.get("usage"):
                        self._usage(event["usage"])
                    for choice in event.get("choices") or ():
                        content = (choice.get("delta") or {}).get("content")
                        if content:
                            if chars == 0:
                                self.timing["first_token_ms"] = (time.perf_counter() - started) * 1000
                            chars += len(content)
                            if chars > MAX_CONTENT_CHARS:
                                raise ProviderFailure("provider_response_too_large")
                            yield content
                        finish = choice.get("finish_reason") or finish
                if finish == "length":
                    raise ProviderFailure("provider_output_truncated")
        except httpx.TimeoutException as exc:
            raise ProviderFailure("provider_timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderFailure("provider_unavailable") from exc
        except (ValueError, TypeError, AttributeError) as exc:
            raise ProviderFailure("provider_invalid_response") from exc
        finally:
            self.timing["stream_ms"] = (time.perf_counter() - started) * 1000

    async def complete(self, messages: list[dict], max_tokens: int = 1500) -> str:
        """One non-streaming call (used for a single-move repair)."""
        if not self.api_key:
            raise ProviderFailure("provider_not_configured")
        try:
            response = await self.client.post(f"{META_BASE}/chat/completions", json=self._body(messages, False, max_tokens),
                                              headers={"Authorization": f"Bearer {self.api_key}"},
                                              timeout=httpx.Timeout(12, connect=5))
            if response.status_code != 200:
                raise ProviderFailure(_status_code(response.status_code))
            if len(response.content) > 65_536:
                raise ProviderFailure("provider_response_too_large")
            value = response.json()
            self._usage(value.get("usage"))
            return value["choices"][0]["message"]["content"] or ""
        except httpx.TimeoutException as exc:
            raise ProviderFailure("provider_timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderFailure("provider_unavailable") from exc
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
            raise ProviderFailure("provider_invalid_response") from exc


def _status_code(status: int) -> str:
    if status in (401, 403):
        return "provider_auth_failed"
    return "provider_rate_limited" if status == 429 else "provider_http_error"
