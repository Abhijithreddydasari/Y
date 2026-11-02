"""Muse Image illustrations for `image` moves, generated in the background and stored as board assets.

The browser never sends an image prompt: the turn engine starts a job when it accepts an `image`
move. A job is charged to per-owner and global hourly budgets before the paid call, bounded in time
and concurrency, and never blocks or fails the turn. A finished image is a content-addressed board
asset, so it is owner-scoped and restored with the board. Illustrations only: the prompt asks for no
text, and the lesson's maths never comes from the image.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os
import secrets
import time

import anyio
import httpx
from sqlalchemy import Column, Float, ForeignKey, String, Table, Text, insert, select, update

from .storage import CaptureStore, StoreError, metadata
from .tutor_models import META_BASE

log = logging.getLogger("y.images")
IMAGE_MODEL = "muse-image-1.0"
STYLE = (" Style: a clean, friendly flat illustration with soft colours on a plain light background."
         " Absolutely no text, letters, numbers, labels, equations or captions anywhere in the image.")
HOURLY_IMAGES, HOURLY_IMAGES_GLOBAL = 10, 60
TIMEOUT_SECONDS = 25
MAX_IMAGE_BYTES = 2 * 1024 * 1024  # the board asset limit
CONCURRENT_IMAGES = 2
_slots: dict[asyncio.AbstractEventLoop, asyncio.Semaphore] = {}  # a semaphore belongs to one event loop
_running: set[asyncio.Task] = set()  # strong references so jobs outlive the request that started them


def _slot() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    if loop not in _slots:
        for stale in [other for other in _slots if other.is_closed()]:
            del _slots[stale]
        _slots[loop] = asyncio.Semaphore(CONCURRENT_IMAGES)
    return _slots[loop]

jobs = Table("learning_image_jobs", metadata,
    Column("image_id", String(32), primary_key=True),
    Column("session_id", ForeignKey("learning_sessions.session_id"), nullable=False, index=True),
    Column("turn_id", String(36), nullable=False), Column("prompt", Text, nullable=False), Column("alt", Text, nullable=False),
    Column("status", String(16), nullable=False), Column("asset_hash", String(64)), Column("error", String(40)),
    Column("ms", Float), Column("created_at", Float, nullable=False))
_ready: set[int] = set()


class ImageFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ImageJobs:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine
        if id(self.engine) not in _ready:
            jobs.create(self.engine, checkfirst=True)
            _ready.add(id(self.engine))

    def create(self, owner: str, sid: str, turn_id: str, prompt: str, alt: str, configured: bool = True) -> dict:
        """A pending job charged to the budgets, or a failed one when the budget or key is missing."""
        image_id, status, error = secrets.token_hex(16), "pending", None
        with self.engine.begin() as conn:
            self.capture._session(conn, owner, sid)
            if not configured:
                status, error = "failed", "image_not_configured"
            else:
                hour = int(time.time() // 3600)
                try:
                    with conn.begin_nested():
                        self.capture._spend(conn, f"image-global:{hour}", HOURLY_IMAGES_GLOBAL)
                        self.capture._spend(conn, f"image-{owner}:{hour}", HOURLY_IMAGES)
                except StoreError:
                    status, error = "failed", "image_budget"
            conn.execute(insert(jobs).values(image_id=image_id, session_id=sid, turn_id=turn_id, prompt=prompt, alt=alt,
                                             status=status, error=error, created_at=time.time()))
        return {"image_id": image_id, "status": status, "error": error}

    def finish(self, image_id: str, status: str, asset_hash: str | None = None, error: str | None = None,
               ms: float | None = None) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(jobs).where(jobs.c.image_id == image_id, jobs.c.status == "pending").values(
                status=status, asset_hash=asset_hash, error=error, ms=ms))

    def get(self, owner: str, sid: str, image_id: str) -> dict:
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, sid)
            row = conn.execute(select(jobs).where(jobs.c.image_id == image_id, jobs.c.session_id == sid)).mappings().first()
        if row is None:
            raise StoreError(404, "image_not_found")
        return {"image_id": row["image_id"], "status": row["status"], "asset_hash": row["asset_hash"], "alt": row["alt"],
                "error": row["error"], "ms": row["ms"] and round(row["ms"])}


def api_key() -> str:
    return os.environ.get("MODEL_API_KEY", "").strip()


async def generate(client: httpx.AsyncClient, key: str, prompt: str) -> bytes:
    """One Muse Image call; returns the image bytes or raises ImageFailure with a safe code."""
    try:
        response = await client.post(f"{META_BASE}/images/generations", json={"model": IMAGE_MODEL, "prompt": prompt + STYLE},
                                     headers={"Authorization": f"Bearer {key}"}, timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=5))
    except httpx.TimeoutException as exc:
        raise ImageFailure("image_timeout") from exc
    except httpx.HTTPError as exc:
        raise ImageFailure("image_unavailable") from exc
    if response.status_code != 200:
        raise ImageFailure("image_auth_failed" if response.status_code in (401, 403)
                           else "image_rate_limited" if response.status_code == 429 else "image_http_error")
    try:
        data = base64.b64decode(response.json()["data"][0]["b64_json"], validate=True)
    except (ValueError, KeyError, IndexError, TypeError, binascii.Error) as exc:
        raise ImageFailure("image_invalid_response") from exc
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ImageFailure("image_too_large")
    return data


async def run(store: ImageJobs, boards, client: httpx.AsyncClient | None, owner: str, sid: str, image_id: str, prompt: str) -> None:
    started = time.perf_counter()
    try:
        with anyio.fail_after(TIMEOUT_SECONDS + 5):
            async with _slot():
                if client is None:
                    async with httpx.AsyncClient() as own:
                        data = await generate(own, api_key(), prompt)
                else:
                    data = await generate(client, api_key(), prompt)
        asset = await anyio.to_thread.run_sync(boards.put_asset, owner, sid, data)
        ms = (time.perf_counter() - started) * 1000
        await anyio.to_thread.run_sync(lambda: store.finish(image_id, "ready", asset["hash"], None, ms))
        log.info("image %s ready in %.0f ms", image_id, ms)
    except BaseException as exc:  # a failed illustration never touches the lesson
        code = getattr(exc, "code", None) or ("image_timeout" if isinstance(exc, TimeoutError) else "image_failed")
        if isinstance(exc, StoreError):
            code = "image_store_failed"
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(lambda: store.finish(image_id, "failed", None, code, (time.perf_counter() - started) * 1000))
        log.warning("image %s failed: %s (%s)", image_id, code, type(exc).__name__)
        if not isinstance(exc, Exception):
            raise


def start(store: ImageJobs, boards, client, owner: str, sid: str, image_id: str, prompt: str) -> asyncio.Task:
    task = asyncio.get_running_loop().create_task(run(store, boards, client, owner, sid, image_id, prompt))
    _running.add(task)
    task.add_done_callback(_running.discard)
    return task
