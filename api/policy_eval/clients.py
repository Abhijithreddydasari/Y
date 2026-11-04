"""Paid model calls for H10, each bounded by the Budget, a per-provider semaphore and one retry.

Keys come from the environment (root `.env`) and are only ever placed in request headers.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

import httpx

from learning.consolidate import NOTES_MODEL
from learning.decisions import ProviderFailure
from learning.tutor_models import BASETEN_BASE, META_BASE
from learning.tutor_provider import MetaTutor

from .budget import Budget

# H10's offline cross-judge only: it never runs in the app.
OPENAI_BASE, OPENAI_DECISION_MODEL = "https://api.openai.com/v1", "gpt-6-luna"
TUTOR_MODEL, TUTOR_EFFORT = "muse-spark-1.3", "minimal"
REFLECT_EFFORT = "medium"
OPEN_MODEL = NOTES_MODEL  # Muse Spark Open on Baseten: student and judge
CONCURRENCY = 4
RETRYABLE = ("provider_timeout", "provider_rate_limited", "provider_http_error", "provider_unavailable",
             "provider_invalid_response", "empty_content")


class CallFailed(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class CountingTutor(MetaTutor):
    """The production adapter; usage is summed over the stream and its repairs instead of overwritten."""

    def __init__(self, client: httpx.AsyncClient, budget: Budget, sem: asyncio.Semaphore, system_prompt: str):
        super().__init__(client, model=TUTOR_MODEL)
        self.effort, self.budget, self.sem, self.system_prompt = TUTOR_EFFORT, budget, sem, system_prompt
        self.totals: dict[str, int] = {}

    def _usage(self, value: dict | None) -> None:
        before, self.usage = self.usage, {}
        super()._usage(value)
        for key, amount in self.usage.items():
            self.totals[key] = self.totals.get(key, 0) + amount
        self.usage = before

    async def complete(self, messages, max_tokens: int = 1500, fmt=None) -> str:
        # Repairs: TurnRun reserves the call (its `reserve` hook); swap in the candidate system prompt.
        messages = [{**messages[0], "content": self.system_prompt}, *messages[1:]] if messages else messages
        started = time.perf_counter()
        async with self.sem:
            try:
                out = await super().complete(messages, max_tokens, fmt)
                self.budget.record("tutor_repair", self.model, "ok", (time.perf_counter() - started) * 1000)
                return out
            except ProviderFailure as exc:
                self.budget.record("tutor_repair", self.model, exc.code, (time.perf_counter() - started) * 1000)
                raise


class Clients:
    def __init__(self, budget: Budget, http: httpx.AsyncClient | None = None):
        self.budget = budget
        self.http = http or httpx.AsyncClient(limits=httpx.Limits(max_connections=16))
        self.meta_sem = asyncio.Semaphore(CONCURRENCY)  # repairs and reflection
        self.stream_sem = asyncio.Semaphore(CONCURRENCY)  # turn streams; separate so a stream never waits on its own repair
        self.open_sem = asyncio.Semaphore(CONCURRENCY)
        self.openai_sem = asyncio.Semaphore(CONCURRENCY)

    async def aclose(self) -> None:
        await self.http.aclose()

    def tutor(self, system_prompt: str) -> CountingTutor:
        return CountingTutor(self.http, self.budget, self.meta_sem, system_prompt)

    async def _post(self, role: str, url: str, key_env: str, body: dict, sem: asyncio.Semaphore, timeout: float,
                    content=lambda raw: raw) -> tuple[object, dict]:
        """POST with one retry on a retryable failure; each attempt is reserved and logged."""
        key = os.environ.get(key_env, "").strip()
        if not key:
            raise CallFailed(f"{key_env.lower()}_missing")
        last = "provider_unavailable"
        for attempt in range(2):
            self.budget.reserve(role)
            started = time.perf_counter()
            usage: dict = {}
            try:
                async with sem:
                    r = await self.http.post(url, json=body, timeout=httpx.Timeout(timeout, connect=10),
                                             headers={"Authorization": f"Bearer {key}"})
                if r.status_code != 200:
                    last = ("provider_auth_failed" if r.status_code in (401, 403) else
                            "provider_rate_limited" if r.status_code == 429 else "provider_http_error")
                else:
                    raw = r.json()
                    usage = _usage(raw.get("usage"))
                    value = content(raw)
                    self.budget.record(role, body.get("model", "?"), "ok", (time.perf_counter() - started) * 1000, usage)
                    return value, usage
            except httpx.TimeoutException:
                last = "provider_timeout"
            except httpx.HTTPError:
                last = "provider_unavailable"
            except CallFailed as exc:
                last = exc.code
            except (ValueError, KeyError, IndexError, TypeError):
                last = "provider_invalid_response"
            self.budget.record(role, body.get("model", "?"), last, (time.perf_counter() - started) * 1000, usage)
            if last not in RETRYABLE:
                break
            await asyncio.sleep(2 + 3 * attempt)
        raise CallFailed(last)

    async def open_json(self, role: str, system: str, user: str, schema: dict, max_tokens: int = 6000) -> dict:
        """Muse Spark Open on Baseten with a strict JSON schema; returns the parsed object."""
        body = {"model": OPEN_MODEL, "max_tokens": max_tokens, "reasoning_effort": "low",
                "response_format": {"type": "json_schema", "json_schema": {"name": role, "strict": True, "schema": schema}},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        value, _ = await self._post(role, f"{BASETEN_BASE}/chat/completions", "BASETEN_API_KEY", body, self.open_sem,
                                    90, _json_content)
        return value

    async def reflect(self, prompt: str) -> str:
        """Muse Spark 1.3 at medium effort rewrites a policy section (GEPA's reflection model)."""
        body = {"model": TUTOR_MODEL, "reasoning_effort": REFLECT_EFFORT, "max_tokens": 12000,
                "messages": [{"role": "user", "content": prompt}]}
        value, _ = await self._post("reflect", f"{META_BASE}/chat/completions", "MODEL_API_KEY", body, self.meta_sem,
                                    180, _text_content)
        return value

    async def decide(self, role: str, data: dict, questions: list[dict]) -> list[dict]:
        """OpenAI Decisions (`gpt-6-luna`): typed choice answers with probabilities, in question order."""
        body = {"model": OPENAI_DECISION_MODEL,
                "input": [{"role": "user", "content": [{"type": "input_json", "data": data}]}],
                "questions": questions}
        base = os.environ.get("OPENAI_BASE_URL") or OPENAI_BASE
        value, _ = await self._post(role, f"{base}/decisions", "OPENAI_API_KEY", body, self.openai_sem, 60,
                                    lambda raw: raw["answers"])
        if not isinstance(value, list) or len(value) != len(questions):
            raise CallFailed("provider_invalid_response")
        return value


def _usage(value: dict | None) -> dict:
    value = value or {}
    out = {"input_tokens": value.get("prompt_tokens", value.get("input_tokens")),
           "output_tokens": value.get("completion_tokens", value.get("output_tokens")),
           "cached_tokens": (value.get("prompt_tokens_details") or {}).get("cached_tokens"),
           "reasoning_tokens": (value.get("completion_tokens_details") or {}).get("reasoning_tokens")}
    return {k: v for k, v in out.items() if isinstance(v, int)}


def _text_content(raw: dict) -> str:
    text = raw["choices"][0]["message"].get("content") or ""
    if not text.strip():
        raise CallFailed("empty_content")  # reasoning used the whole budget
    return text


def _json_content(raw: dict) -> dict:
    return json.loads(_text_content(raw))
