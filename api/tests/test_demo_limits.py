from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from demo_limits import DemoLimiter


def test_demo_limiter_caps_queue(monkeypatch) -> None:
    monkeypatch.setenv("DEMO_RATE_LIMITS", "1")
    monkeypatch.setenv("DEMO_MAX_ACTIVE", "1")
    monkeypatch.setenv("DEMO_MAX_QUEUE", "0")
    limiter = DemoLimiter()

    async def run() -> None:
        permit = await limiter.acquire("learner", "lesson")
        with pytest.raises(HTTPException) as exc:
            await limiter.acquire("other", "lesson")
        assert exc.value.status_code == 429
        await permit.release()

    asyncio.run(run())


def test_demo_limiter_enforces_hourly_quota(monkeypatch) -> None:
    monkeypatch.setenv("DEMO_RATE_LIMITS", "1")
    monkeypatch.setenv("DEMO_LESSONS_PER_HOUR", "1")
    limiter = DemoLimiter()

    async def run() -> None:
        permit = await limiter.acquire("learner", "lesson")
        await permit.release()
        with pytest.raises(HTTPException) as exc:
            await limiter.acquire("learner", "lesson")
        assert exc.value.status_code == 429
        assert "Retry-After" in exc.value.headers

    asyncio.run(run())
