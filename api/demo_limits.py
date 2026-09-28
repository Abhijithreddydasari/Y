"""Small in-process guardrail for the anonymous event demo.

The limiter is deliberately disabled unless ``DEMO_RATE_LIMITS=1``. Modal's
event deployment runs a single warm container, so an in-process token bucket
is enough to protect the one GPU without adding a database to the product.
"""
from __future__ import annotations

import asyncio
import os
import time
from collections import defaultdict
from dataclasses import dataclass

from fastapi import HTTPException


def _enabled() -> bool:
    return os.environ.get("DEMO_RATE_LIMITS", "0").lower() in {"1", "true", "yes"}


@dataclass
class DemoPermit:
    limiter: "DemoLimiter | None"
    released: bool = False

    async def release(self) -> None:
        if self.released or self.limiter is None:
            return
        self.released = True
        await self.limiter.release()


class DemoLimiter:
    def __init__(self) -> None:
        self.enabled = _enabled()
        self.max_active = max(1, int(os.environ.get("DEMO_MAX_ACTIVE", "1")))
        self.max_queue = max(0, int(os.environ.get("DEMO_MAX_QUEUE", "4")))
        self.quotas = {
            "lesson": max(1, int(os.environ.get("DEMO_LESSONS_PER_HOUR", "8"))),
            "assess": max(1, int(os.environ.get("DEMO_ASSESSMENTS_PER_HOUR", "8"))),
            "chat": max(1, int(os.environ.get("DEMO_CHATS_PER_HOUR", "20"))),
        }
        self._semaphore = asyncio.Semaphore(self.max_active)
        self._guard = asyncio.Lock()
        self._counts: dict[tuple[str, str, int], int] = defaultdict(int)
        self._active = 0
        self._waiting = 0

    async def acquire(self, user_id: str, kind: str) -> DemoPermit:
        if not self.enabled:
            return DemoPermit(None)
        hour = int(time.time() // 3600)
        key = (user_id[:160] or "anon", kind, hour)
        async with self._guard:
            stale = [item for item in self._counts if item[2] < hour - 1]
            for item in stale:
                self._counts.pop(item, None)
            quota = self.quotas.get(kind, 8)
            if self._counts[key] >= quota:
                raise HTTPException(
                    status_code=429,
                    detail=f"Event demo limit reached for {kind}. Try again next hour.",
                    headers={"Retry-After": "900"},
                )
            if self._active >= self.max_active and self._waiting >= self.max_queue:
                raise HTTPException(
                    status_code=429,
                    detail="The live demo is busy. Try again in about 20 seconds.",
                    headers={"Retry-After": "20"},
                )
            self._counts[key] += 1
            self._waiting += 1
        try:
            await self._semaphore.acquire()
        except BaseException:
            async with self._guard:
                self._waiting = max(0, self._waiting - 1)
                self._counts[key] = max(0, self._counts[key] - 1)
            raise
        async with self._guard:
            self._waiting = max(0, self._waiting - 1)
            self._active += 1
        return DemoPermit(self)

    async def release(self) -> None:
        async with self._guard:
            self._active = max(0, self._active - 1)
        self._semaphore.release()

    def snapshot(self) -> dict:
        return {
            "enabled": self.enabled,
            "active": self._active,
            "waiting": self._waiting,
            "max_active": self.max_active,
            "max_queue": self.max_queue,
        }


demo_limiter = DemoLimiter()
