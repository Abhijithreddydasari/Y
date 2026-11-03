"""Demo personas ("Try as…"): list, switch and reset the viewer's private persona copies."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import Field

from .contracts import Contract
from .personas import PersonaStore
from .router import call_store, get_store, private_response, require_viewer

router = APIRouter(prefix="/learning", tags=["personas"], dependencies=[Depends(private_response)])


class ActiveInput(Contract):
    # None is "Your own": the viewer's own anonymous profile.
    persona: str | None = Field(default=None, pattern=r"^[a-z]{1,32}$")


@router.get("/personas")
async def personas(viewer=Depends(require_viewer), store=Depends(get_store)):
    return await call_store(PersonaStore(store).listing, viewer)


@router.put("/personas/active")
async def activate(body: ActiveInput, viewer=Depends(require_viewer), store=Depends(get_store)):
    """Act as a persona (its private copy is built on first pick) or, with null, as yourself again."""
    return await call_store(PersonaStore(store).activate, viewer, body.persona)


@router.post("/personas/{key}/reset")
async def reset(key: str, viewer=Depends(require_viewer), store=Depends(get_store)):
    """Discard this viewer's copy, including anything learned in it, and rebuild it from the template."""
    return await call_store(PersonaStore(store).reset, viewer, key)
