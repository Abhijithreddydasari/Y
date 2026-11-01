"""Versioned board boundaries. Geometry is scene-space, provenance is app-observed."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import ConfigDict, Field, model_validator

from .contracts import Assistance, Contract, Identifier

Actor = Literal["human", "model", "system", "unknown"]


class Rect(Contract):
    x: float
    y: float
    w: float = Field(gt=0, le=1_000_000)
    h: float = Field(gt=0, le=1_000_000)


class Element(Contract):
    model_config = ConfigDict(extra="allow", frozen=True, allow_inf_nan=False)
    id: Identifier
    type: str = Field(min_length=1, max_length=40)
    x: float = Field(ge=-1e7, le=1e7)
    y: float = Field(ge=-1e7, le=1e7)
    width: float = Field(ge=-1e6, le=1e6)
    height: float = Field(ge=-1e6, le=1e6)
    angle: float = 0
    isDeleted: bool = False
    version: int = Field(default=1, ge=0)

    @model_validator(mode="after")
    def valid_scene_value(self):
        import math
        from .contracts import canonical
        from .decisions import _check_json_storage
        value = self.model_dump(mode="python")
        _check_json_storage(value)
        canonical(value).encode("utf-8")
        points = value.get("points")
        if points is not None:
            if not isinstance(points, list) or len(points) > 30_000:
                raise ValueError("invalid stroke points")
            for point in points:
                if not isinstance(point, (list, tuple)) or len(point) != 2 or any(type(n) not in (int, float) or not math.isfinite(n) for n in point):
                    raise ValueError("invalid stroke point")
        for key in ("groupIds", "boundElements"):
            if value.get(key) is not None and not isinstance(value[key], list):
                raise ValueError("invalid relationship list")
        for key in ("startBinding", "endBinding", "customData"):
            if value.get(key) is not None and not isinstance(value[key], dict):
                raise ValueError("invalid element metadata")
        return self


class Edit(Contract):
    element: Element
    actor: Actor
    source_revision: int | None = Field(default=None, ge=0)


class EditBatch(Contract):
    operation_id: UUID
    expected_revision: int = Field(ge=0)
    edits: list[Edit] = Field(max_length=5000)
    viewport: Rect | None = None

    @model_validator(mode="after")
    def unique(self):
        if len({e.element.id for e in self.edits}) != len(self.edits):
            raise ValueError("duplicate element ID")
        return self


class RegionInput(Contract):
    region_id: UUID
    task_id: Identifier
    expected_revision: int = Field(ge=0)


class BoardSource(Contract):
    schema_version: Literal[1] = 1
    session_id: UUID
    revision: int = Field(ge=0)
    element_revisions: dict[str, int]
    content_hash: str
    crop_hashes: tuple[str, ...] = ()


class Crop(Contract):
    asset_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    bounds: Rect
    element_ids: list[Identifier] = Field(min_length=1, max_length=200)
    purpose: Literal["initial", "detail"] = "initial"


class ContextInput(Contract):
    request_id: UUID
    revision: int = Field(ge=0)
    region_id: UUID | None = None
    selection: list[Identifier] = Field(default_factory=list, max_length=200)
    viewport: Rect | None = None
    crops: list[Crop] = Field(default_factory=list, max_length=4)
    assistance: Assistance = Field(default_factory=Assistance)


class ContextPacket(Contract):
    schema_version: Literal[1] = 1
    source: BoardSource
    task_id: str | None
    question: str
    focused: list[dict]
    overview: list[dict]
    coverage: dict
    crops: list[Crop]
    assistance: Assistance
    response_area: Rect


class ReadingItem(Contract):
    element_ids: list[Identifier] = Field(min_length=1, max_length=200)
    text: str = Field(max_length=8000)
    status: Literal["readable", "ambiguous", "unreadable"]
    critical: bool
    relationships: list[str] = Field(default_factory=list, max_length=30)


class Interpretation(Contract):
    schema_version: Literal[1] = 1
    items: list[ReadingItem] = Field(max_length=200)


class TeachInput(ContextInput):
    model_choice: Literal["edge", "edge-ft", "cloud", "openai"] = "edge"


class Correction(Contract):
    correction_id: UUID
    text: str = Field(min_length=1, max_length=8000)
