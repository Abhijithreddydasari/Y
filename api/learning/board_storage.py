"""Additive board schema and transactional repository. Inference never holds a transaction."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from io import BytesIO
from typing import Protocol
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from sqlalchemy import Column, Float, ForeignKey, Integer, LargeBinary, String, Table, Text, insert, select, update, func
from sqlalchemy.exc import IntegrityError

from .board_contracts import ContextInput, EditBatch, RegionInput
from .board_context import bounds, build_context
from .contracts import canonical, digest
from .storage import CaptureStore, StoreError, metadata

schema = Table("learning_schema", metadata, Column("version", Integer, primary_key=True))
boards = Table("learning_boards", metadata,
    Column("session_id", ForeignKey("learning_sessions.session_id"), primary_key=True),
    Column("revision", Integer, nullable=False), Column("scene", Text, nullable=False),
    Column("viewport", Text), Column("regions", Text, nullable=False), Column("active_region", String(36)))
batches = Table("learning_board_batches", metadata,
    Column("operation_id", String(36), primary_key=True), Column("session_id", ForeignKey("learning_boards.session_id"), nullable=False, index=True),
    Column("revision", Integer, nullable=False), Column("request_hash", String(64), nullable=False),
    Column("edits", Text, nullable=False), Column("viewport", Text), Column("regions", Text, nullable=False))
checkpoints = Table("learning_board_checkpoints", metadata,
    Column("session_id", ForeignKey("learning_boards.session_id"), primary_key=True), Column("revision", Integer, primary_key=True),
    Column("scene", Text, nullable=False), Column("viewport", Text), Column("regions", Text, nullable=False))
assets = Table("learning_board_assets", metadata,
    Column("session_id", ForeignKey("learning_sessions.session_id"), primary_key=True), Column("hash", String(64), primary_key=True),
    Column("content", LargeBinary, nullable=False), Column("size", Integer, nullable=False),
    Column("mime", String(40), nullable=False), Column("width", Integer, nullable=False), Column("height", Integer, nullable=False))
board_attempts = Table("learning_board_attempts", metadata,
    Column("attempt_id", String(36), primary_key=True), Column("session_id", ForeignKey("learning_sessions.session_id"), nullable=False, index=True),
    Column("request_hash", String(64), nullable=False), Column("packet", Text, nullable=False),
    Column("result", Text), Column("lease_token", String(64)), Column("lease_until", Float, nullable=False),
    Column("runs", Integer, nullable=False), Column("created_at", Float, nullable=False))
readings = Table("learning_board_readings", metadata,
    Column("cache_key", String(64), primary_key=True), Column("result", Text),
    Column("lease_token", String(64)), Column("lease_until", Float, nullable=False), Column("expires_at", Float, nullable=False))
corrections = Table("learning_board_corrections", metadata,
    Column("correction_id", String(36), primary_key=True), Column("attempt_id", ForeignKey("learning_board_attempts.attempt_id"), nullable=False),
    Column("text", Text, nullable=False), Column("actor", String(16), nullable=False), Column("created_at", Float, nullable=False))
assessment_runs = Table("learning_board_assessment_runs", metadata,
    Column("run_id", String(36), primary_key=True), Column("attempt_id", ForeignKey("learning_board_attempts.attempt_id"), nullable=False),
    Column("result", Text, nullable=False))


def upgrade(engine):
    """Schema v2 adds tables only; leaves existing typed-capture rows unchanged."""
    metadata.create_all(engine)
    with engine.begin() as conn:
        if conn.scalar(select(schema.c.version).where(schema.c.version == 2)) is None:
            if conn.dialect.name == "postgresql":
                from sqlalchemy.dialects.postgresql import insert as upsert
            else:
                from sqlalchemy.dialects.sqlite import insert as upsert
            conn.execute(upsert(schema).values(version=2).on_conflict_do_nothing())


class AssetStore(Protocol):
    def put_asset(self, owner: str, sid: str, content: bytes) -> dict: ...
    def get_asset(self, owner: str, sid: str, key: str) -> dict: ...


def validate_image(content: bytes) -> tuple[str, int, int]:
    if not content or len(content) > 2 * 1024 * 1024:
        raise StoreError(413, "board_asset_size_limit")
    try:
        with Image.open(BytesIO(content)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > 16_000_000:
                raise StoreError(422, "board_asset_format_or_pixel_limit")
            result = (Image.MIME[image.format], image.width, image.height)
            image.verify()
            return result
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise StoreError(422, "board_asset_invalid") from exc


class BoardStore:
    def __init__(self, capture: CaptureStore):
        self.capture, self.engine = capture, capture.engine

    def _board(self, conn, owner, sid):
        self.capture._session(conn, owner, str(sid))
        row = conn.execute(select(boards).where(boards.c.session_id == str(sid))).mappings().first()
        if row is None:
            # Session update serializes initialization across instances.
            from .storage import sessions
            conn.execute(update(sessions).where(sessions.c.session_id == str(sid)).values(revision=sessions.c.revision))
            row = conn.execute(select(boards).where(boards.c.session_id == str(sid))).mappings().first()
            if row is None:
                conn.execute(insert(boards).values(session_id=str(sid), revision=0, scene="{}", regions="[]"))
                row = conn.execute(select(boards).where(boards.c.session_id == str(sid))).mappings().one()
        return row

    @staticmethod
    def view(row):
        regions = json.loads(row["regions"])
        return {"revision": row["revision"], "records": json.loads(row["scene"]),
                "viewport": json.loads(row["viewport"]) if row["viewport"] else None,
                "regions": regions, "active_region": regions[-1]["region_id"] if regions else None}

    def load(self, owner, sid, revision=None):
        with self.engine.begin() as conn:
            row = self._board(conn, owner, sid)
            if revision is None or revision == row["revision"]:
                return self.view(row)
            if not 0 <= revision <= row["revision"]:
                raise StoreError(404, "board_revision_not_found")
            base = conn.execute(select(checkpoints).where(checkpoints.c.session_id == str(sid), checkpoints.c.revision <= revision)
                                .order_by(checkpoints.c.revision.desc()).limit(1)).mappings().first()
            scene, start, viewport, regions = (json.loads(base["scene"]), base["revision"], base["viewport"], base["regions"]) if base else ({}, 0, None, "[]")
            rows = conn.execute(select(batches).where(batches.c.session_id == str(sid), batches.c.revision > start,
                batches.c.revision <= revision).order_by(batches.c.revision)).mappings()
            for batch in rows:
                scene.update(json.loads(batch["edits"]))
                viewport, regions = batch["viewport"], batch["regions"]
            return self.view({"revision": revision, "scene": canonical(scene), "viewport": viewport, "regions": regions})

    def put_asset(self, owner, sid, content):
        mime, width, height = validate_image(content)
        key = hashlib.sha256(content).hexdigest()
        with self.engine.begin() as conn:
            row = self._board(conn, owner, sid)
            # Lock the board to enforce the aggregate cap and dedupe atomically.
            conn.execute(update(boards).where(boards.c.session_id == str(sid)).values(revision=boards.c.revision))
            existing = conn.execute(select(assets).where(assets.c.session_id == str(sid), assets.c.hash == key)).first()
            if not existing:
                size = conn.scalar(select(func.sum(assets.c.size)).where(assets.c.session_id == str(sid))) or 0
                if size + len(content) > 32 * 1024 * 1024:
                    raise StoreError(413, "board_session_asset_limit")
                conn.execute(insert(assets).values(session_id=str(sid), hash=key, content=content, size=len(content), mime=mime, width=width, height=height))
        return {"hash": key, "mime": mime, "width": width, "height": height}

    def get_asset(self, owner, sid, key):
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, str(sid))
            row = conn.execute(select(assets).where(assets.c.session_id == str(sid), assets.c.hash == key)).mappings().first()
            if row is None:
                raise StoreError(404, "board_asset_not_found")
            return dict(row)

    def apply(self, owner, sid, batch: EditBatch, region=None):
        payload = canonical({"batch": batch.model_dump(mode="json"), "region": region})
        if len(payload.encode("utf-8")) > 1024 * 1024:
            raise StoreError(413, "board_batch_size_limit")
        request_hash = digest(payload)
        with self.engine.begin() as conn:
            row = self._board(conn, owner, sid)
            previous = conn.execute(select(batches).where(batches.c.operation_id == str(batch.operation_id))).mappings().first()
            if previous:
                if previous["session_id"] != str(sid) or previous["request_hash"] != request_hash:
                    raise StoreError(409, "board_operation_reused")
                return {"revision": previous["revision"], "operation_id": str(batch.operation_id)}
            changed = conn.execute(update(boards).where(boards.c.session_id == str(sid), boards.c.revision == batch.expected_revision)
                                   .values(revision=boards.c.revision + 1))
            if changed.rowcount != 1:
                # Another instance may have committed this operation while this transaction waited.
                previous = conn.execute(select(batches).where(batches.c.operation_id == str(batch.operation_id), batches.c.session_id == str(sid))).mappings().first()
                if previous and previous["request_hash"] == request_hash:
                    return {"revision": previous["revision"], "operation_id": str(batch.operation_id)}
                raise StoreError(409, "board_revision_conflict")
            scene, regions, revision = json.loads(row["scene"]), json.loads(row["regions"]), batch.expected_revision + 1
            active = regions[-1]["region_id"] if regions else None
            edits = {}
            for edit in batch.edits:
                e = edit.element.model_dump(mode="json")
                old = scene.get(e["id"])
                # Client customData is a display aid, never authoritative provenance.
                if edit.actor != "model" and (not old or old["element"].get("text") != e.get("text") or old["element"].get("fileId") != e.get("fileId") or old["element"].get("points") != e.get("points")):
                    e["customData"] = {k: v for k, v in (e.get("customData") or {}).items() if k != "ySemantic"}
                if edit.actor == "model" and edit.source_revision is None:
                    raise StoreError(422, "model_source_revision_required")
                if e["type"] == "image" and not e.get("isDeleted"):
                    key = (e.get("customData") or {}).get("yAssetHash")
                    if not key or not conn.scalar(select(assets.c.hash).where(assets.c.session_id == str(sid), assets.c.hash == key)):
                        raise StoreError(422, "board_asset_missing")
                creator = old["creator"] if old else edit.actor
                record = {"element": e, "revision": revision, "creator": creator, "editor": edit.actor,
                          "mixed": bool(old and (old["mixed"] or creator != edit.actor)),
                          "task_region": old.get("task_region") if old else active,
                          "source_revision": edit.source_revision}
                scene[e["id"]] = edits[e["id"]] = record
            if sum(not r["element"].get("isDeleted") for r in scene.values()) > 5000 or len(scene) > 20_000:
                raise StoreError(413, "board_element_limit")
            if region:
                regions.append(region)
            viewport = canonical(batch.viewport) if batch.viewport else row["viewport"]
            conn.execute(update(boards).where(boards.c.session_id == str(sid)).values(scene=canonical(scene), viewport=viewport, regions=canonical(regions)))
            conn.execute(insert(batches).values(operation_id=str(batch.operation_id), session_id=str(sid), revision=revision,
                         request_hash=request_hash, edits=canonical(edits), viewport=viewport, regions=canonical(regions)))
            if revision % 50 == 0:
                conn.execute(insert(checkpoints).values(session_id=str(sid), revision=revision, scene=canonical(scene), viewport=viewport, regions=canonical(regions)))
            return {"revision": revision, "operation_id": str(batch.operation_id)}

    def region(self, owner, sid, body: RegionInput):
        from .packs import TASKS
        from .board_contracts import Edit, Element
        if body.task_id not in TASKS:
            raise StoreError(404, "task_not_found")
        board = self.load(owner, sid)
        previous = next((r for r in board["regions"] if r["region_id"] == str(body.region_id)), None)
        if previous:
            if previous["task_id"] != body.task_id:
                raise StoreError(409, "region_id_reused")
            return previous
        if len(board["regions"]) >= 100:
            raise StoreError(429, "board_region_limit")
        boxes = [bounds(r["element"]) for r in board["records"].values() if not r["element"].get("isDeleted")]
        x, y = max((b["x"] + b["w"] for b in boxes), default=-100) + 100, 80
        region = {"region_id": str(body.region_id), "task_id": body.task_id, "bounds": {"x": x, "y": y + 130, "w": 900, "h": 1200}}
        prompt = TASKS[body.task_id].prompt
        common = {"x": x, "angle": 0, "version": 1, "strokeColor": "#64748b", "fillStyle": "solid", "roughness": 0,
                  "opacity": 100, "locked": True, "groupIds": [], "boundElements": None, "seed": 1, "versionNonce": 1,
                  "updated": 0, "isDeleted": False, "link": None, "roundness": None, "strokeWidth": 1, "strokeStyle": "dashed", "backgroundColor": "transparent"}
        elements = [Element(**{**common, "id": f"task-{body.region_id}", "type": "text", "y": y, "width": 900, "height": 110,
                              "text": prompt, "originalText": prompt, "fontSize": 20, "fontFamily": 1, "lineHeight": 1.25, "textAlign": "left", "verticalAlign": "top", "containerId": None, "autoResize": False}),
                    Element(**{**common, "id": f"region-{body.region_id}", "type": "rectangle", "y": y + 130, "width": 900, "height": 1200})]
        self.apply(owner, sid, EditBatch(operation_id=body.region_id, expected_revision=body.expected_revision,
            edits=[Edit(element=e, actor="system") for e in elements]), region=region)
        return region

    def capture_context(self, owner, sid, request: ContextInput):
        rh = digest(canonical(request))
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, str(sid))
            prior = conn.execute(select(board_attempts).where(board_attempts.c.attempt_id == str(request.request_id))).mappings().first()
            if prior:
                if prior["session_id"] != str(sid) or prior["request_hash"] != rh:
                    raise StoreError(409, "board_attempt_reused")
                return json.loads(prior["packet"])
        board = self.load(owner, sid, request.revision)
        if request.region_id and not any(r["region_id"] == str(request.region_id) for r in board["regions"]):
            raise StoreError(404, "board_region_not_found")
        for crop in request.crops:
            asset = self.get_asset(owner, sid, crop.asset_hash)
            if asset["width"] > 1600 or asset["height"] > 1600 or asset["width"] * asset["height"] > 2_000_000:
                raise StoreError(422, "board_crop_pixel_limit")
            if any(key not in board["records"] or board["records"][key]["element"].get("isDeleted") for key in crop.element_ids):
                raise StoreError(422, "crop_source_invalid")
        if any(sum(c.purpose == purpose for c in request.crops) > 2 for purpose in ("initial", "detail")):
            raise StoreError(422, "board_crop_count_limit")
        packet = build_context(sid, request.revision, board["records"], board["regions"], request)
        with self.engine.begin() as conn:
            from .storage import sessions
            conn.execute(update(sessions).where(sessions.c.session_id == str(sid)).values(revision=sessions.c.revision))
            if (conn.scalar(select(func.count()).select_from(board_attempts).where(board_attempts.c.session_id == str(sid))) or 0) >= 100:
                raise StoreError(429, "board_attempt_limit")
            try:
                with conn.begin_nested():
                    conn.execute(insert(board_attempts).values(attempt_id=str(request.request_id), session_id=str(sid), request_hash=rh,
                        packet=canonical(packet), lease_until=0, runs=0, created_at=time.time()))
            except IntegrityError:
                prior = conn.execute(select(board_attempts).where(board_attempts.c.attempt_id == str(request.request_id))).mappings().one()
                if prior["session_id"] != str(sid) or prior["request_hash"] != rh:
                    raise StoreError(409, "board_attempt_reused")
        return packet.model_dump(mode="json")

    def attempt(self, owner, aid):
        with self.engine.connect() as conn:
            row = conn.execute(select(board_attempts).where(board_attempts.c.attempt_id == str(aid))).mappings().first()
            if row is None:
                raise StoreError(404, "board_attempt_not_found")
            self.capture._session(conn, owner, row["session_id"])
            changes = conn.execute(select(corrections).where(corrections.c.attempt_id == str(aid)).order_by(corrections.c.created_at)).mappings()
            return {"attempt_id": str(aid), "packet": json.loads(row["packet"]), "result": json.loads(row["result"]) if row["result"] else None,
                    "corrections": [{"text": c["text"], "actor": c["actor"]} for c in changes], "profile_updated": False}

    def list_attempts(self, owner, sid):
        with self.engine.connect() as conn:
            self.capture._session(conn, owner, str(sid))
            ids = conn.scalars(select(board_attempts.c.attempt_id).where(board_attempts.c.session_id == str(sid)).order_by(board_attempts.c.created_at)).all()
        return [self.attempt(owner, aid) for aid in ids]

    def claim_attempt(self, owner, aid):
        value = self.attempt(owner, aid)
        with self.engine.begin() as conn:
            if value["result"] and not value["result"].get("provider_error"):
                return None
            token = secrets.token_hex(16)
            changed = conn.execute(update(board_attempts).where(board_attempts.c.attempt_id == str(aid), board_attempts.c.lease_until <= time.time(),
                board_attempts.c.runs < 3).values(lease_token=token, lease_until=time.time() + 60, runs=board_attempts.c.runs + 1))
            if changed.rowcount != 1:
                raise StoreError(409, "board_assessment_busy_or_retry_limit")
            return token

    def finish(self, aid, token, result):
        with self.engine.begin() as conn:
            changed = conn.execute(update(board_attempts).where(board_attempts.c.attempt_id == str(aid), board_attempts.c.lease_token == token,
                board_attempts.c.lease_until > time.time()).values(result=canonical(result), lease_token=None, lease_until=0,
                runs=board_attempts.c.runs - int(result.get("provider_error") == "provider_not_configured")))
            if changed.rowcount != 1:
                raise StoreError(409, "board_lease_lost")
            conn.execute(insert(assessment_runs).values(run_id=str(uuid4()), attempt_id=str(aid), result=canonical(result)))

    def reserve(self, owner, kind):
        with self.engine.begin() as conn:
            hour = int(time.time() // 3600)
            self.capture._spend(conn, f"board-{kind}-global:{hour}", 120)
            self.capture._spend(conn, f"board-{kind}-{owner}:{hour}", 20)

    def claim_reading(self, key):
        now, token = time.time(), secrets.token_hex(16)
        with self.engine.begin() as conn:
            if conn.dialect.name == "postgresql":
                from sqlalchemy.dialects.postgresql import insert as upsert
            else:
                from sqlalchemy.dialects.sqlite import insert as upsert
            conn.execute(upsert(readings).values(cache_key=key, lease_until=0, expires_at=0).on_conflict_do_nothing())
            row = conn.execute(select(readings).where(readings.c.cache_key == key)).mappings().one()
            if row["result"] and row["expires_at"] > now:
                return None, json.loads(row["result"])
            changed = conn.execute(update(readings).where(readings.c.cache_key == key, readings.c.lease_until <= now)
                                   .values(lease_token=token, lease_until=now + 60))
            if changed.rowcount != 1:
                raise StoreError(409, "board_reading_in_progress")
            return token, None

    def finish_reading(self, key, token, result, ttl):
        with self.engine.begin() as conn:
            changed = conn.execute(update(readings).where(readings.c.cache_key == key, readings.c.lease_token == token, readings.c.lease_until > time.time())
                .values(result=canonical(result) if result is not None else None, expires_at=time.time() + ttl, lease_token=None, lease_until=0))
            if changed.rowcount != 1:
                raise StoreError(409, "board_reading_lease_lost")

    def correct(self, owner, aid, body):
        self.attempt(owner, aid)
        with self.engine.begin() as conn:
            old = conn.execute(select(corrections).where(corrections.c.correction_id == str(body.correction_id))).mappings().first()
            if old:
                if old["attempt_id"] != str(aid) or old["text"] != body.text:
                    raise StoreError(409, "correction_id_reused")
            else:
                conn.execute(insert(corrections).values(correction_id=str(body.correction_id), attempt_id=str(aid), text=body.text, actor="human", created_at=time.time()))
        return self.attempt(owner, aid)
