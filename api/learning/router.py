"""Authenticated, capture-only API. All owner IDs come from opaque credentials."""
from __future__ import annotations

import logging
import os
import threading
from functools import lru_cache
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from .assessment import assess_capture
from .contracts import AttemptInput, Contract
from .decisions import DecisionProvider, configured_provider
from .packs import TASKS, public_catalog
from .storage import CaptureStore, StoreError, local_database_url, make_engine

def private_response(response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Vary"] = "Cookie"


router = APIRouter(prefix="/learning", tags=["learning capture"], dependencies=[Depends(private_response)])
logger = logging.getLogger("y.learning")
COOKIE = "y_learning_identity"
_store_lock = threading.Lock()


@lru_cache(maxsize=1)
def _cached_store() -> CaptureStore:
    url = os.environ.get("LEARNING_DATABASE_URL")
    if not url and os.environ.get("LEARNING_REQUIRE_POSTGRES") == "1":
        raise HTTPException(503, "learning_database_not_configured")
    if url and url.startswith("sqlite") and os.environ.get("LEARNING_REQUIRE_POSTGRES") == "1":
        raise HTTPException(503, "shared_postgres_required")
    store = CaptureStore(make_engine(url or local_database_url()))
    if not url or url.startswith("sqlite"):
        store.initialize()
    return store


def get_store() -> CaptureStore:
    # lru_cache alone can execute the factory twice on concurrent first requests.
    with _store_lock:
        return _cached_store()


def get_provider() -> DecisionProvider:
    try:
        return configured_provider()
    except ValueError as exc:
        raise HTTPException(503, "decision_provider_configuration_invalid") from exc


async def call_store(method, *args):
    try:
        return await run_in_threadpool(method, *args)
    except StoreError as exc:
        raise HTTPException(exc.status, exc.code) from exc


def require_viewer(request: Request, store: CaptureStore = Depends(get_store)) -> str:
    """The cookie's own owner, whatever persona it is trying (persona routes)."""
    owner = store.owner_for_token(request.cookies.get(COOKIE, ""))
    if owner is None:
        raise HTTPException(401, "learning_identity_required")
    return owner


def require_owner(viewer: str = Depends(require_viewer), store: CaptureStore = Depends(get_store)) -> str:
    """The owner requests act as: the viewer's active demo-persona copy, else the viewer. Every owner check
    downstream runs against it, so a copy is reachable only through the viewer that holds it."""
    from .personas import PersonaStore  # imported late: personas loads the tutor and profile stores
    return PersonaStore(store).effective(viewer)


@router.post("/identity")
def identity(request: Request, response: Response, store: CaptureStore = Depends(get_store)):
    token = request.cookies.get(COOKIE, "")
    if store.owner_for_token(token) is None:
        token = store.issue_identity()
        response.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=30 * 86400,
                            secure=os.environ.get("LEARNING_COOKIE_SECURE") == "1", path="/")
    response.headers["Cache-Control"] = "no-store"
    from .personas import PersonaStore
    return {"ready": True, "persona": PersonaStore(store).active(store.owner_for_token(token))}


@router.get("/catalog")
def catalog():
    return {"packs": public_catalog()}


class SessionInput(Contract):
    session_id: UUID


@router.post("/sessions")
async def create_session(body: SessionInput, owner: str = Depends(require_owner), store: CaptureStore = Depends(get_store)):
    return await call_store(store.create_session, owner, body.session_id)


@router.get("/sessions/{session_id}")
async def session(session_id: UUID, owner: str = Depends(require_owner), store: CaptureStore = Depends(get_store)):
    result = await call_store(store.get_session, owner, session_id)
    result["attempts"] = await call_store(store.list_attempts, owner, session_id)
    return result


@router.post("/sessions/{session_id}/attempts")
async def capture(session_id: UUID, body: AttemptInput, owner: str = Depends(require_owner), store: CaptureStore = Depends(get_store)):
    task = TASKS.get(body.task_id)
    if task is None:
        raise HTTPException(404, "task_not_found")
    return await call_store(store.capture, owner, session_id, body, task)


@router.get("/attempts/{attempt_id}")
async def attempt(attempt_id: UUID, owner: str = Depends(require_owner), store: CaptureStore = Depends(get_store)):
    return await call_store(store.get_attempt, owner, attempt_id)


@router.post("/attempts/{attempt_id}/assess")
async def assess(attempt_id: UUID, owner: str = Depends(require_owner),
                 store: CaptureStore = Depends(get_store), provider: DecisionProvider = Depends(get_provider)):
    claim = await call_store(store.claim, owner, attempt_id, bool(provider.api_key))
    if claim is None:
        return await call_store(store.get_attempt, owner, attempt_id)
    token, captured = claim
    # If the process dies or the caller cancels, the saved attempt remains recoverable after the lease.
    result = await assess_capture(captured, provider)
    saved = await call_store(store.complete, owner, attempt_id, token, result)
    logger.info("assessment attempt=%s provider_error=%s latency_ms=%.1f input_tokens=%s output_tokens=%s",
                attempt_id, result.provider_error, result.latency_ms,
                result.usage.get("input_tokens", 0), result.usage.get("output_tokens", 0))
    return saved
