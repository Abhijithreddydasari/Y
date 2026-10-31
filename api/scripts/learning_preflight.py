"""Run from api: python scripts/learning_preflight.py [--live] [--init-db].

No credential values or learner data are printed. --live sends synthetic probes only.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))

import httpx
from learning.contracts import AttemptInput, CapturedAttempt, SourceRef, digest, now_iso
from learning.decisions import ProviderFailure, configured_provider
from learning.packs import TASKS
from learning.storage import CaptureStore, make_engine


def load_environment():
    for path in (API_ROOT.parent / ".env", API_ROOT / ".env"):
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


async def preflight(live: bool, init_db: bool) -> dict:
    report = {"jev_configured": bool(os.environ.get("TYPESAFE_API_KEY")),
              "baseten_configured": bool(os.environ.get("BASETEN_API_KEY")),
              "meta_configured": bool(os.environ.get("MODEL_API_KEY")),
              "database_configured": bool(os.environ.get("LEARNING_DATABASE_URL")),
              "live_requested": live}
    try:
        provider = configured_provider()
    except ValueError:
        report["decision_configuration"] = "invalid"
        return report
    report["decision_provider"] = provider.provider_name
    report["decision_model"] = provider.model
    report["decision_configured"] = bool(provider.api_key)
    url = os.environ.get("LEARNING_DATABASE_URL")
    if init_db and not url:
        report["database"] = "not_configured"
    if url:
        engine = None
        try:
            engine = make_engine(url)
            if init_db:
                CaptureStore(engine).initialize()
            with engine.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            report["database"] = "connected"
        except Exception:
            report["database"] = "connection_or_schema_initialization_failed"
        finally:
            if engine is not None:
                engine.dispose()
    if not live:
        return report
    if report["decision_configured"]:
        text = "Because A is linear, A(-2v)=-2Av=3(-2v), so the eigenvalue stays 3."
        task = TASKS["linear.eigenvector.explain.v1"]
        capture = CapturedAttempt(owner_id="synthetic", session_id=uuid4(),
            attempt=AttemptInput(attempt_id=uuid4(), task_id=task.task_id, text=text), task=task,
            source=SourceRef(event_id=uuid4(), content_hash=digest(text), start=0, end=len(text)), captured_at=now_iso())
        try:
            async with asyncio.timeout(12):
                response, _ = await provider.assess(capture)
            report["decision"] = {"status": "contract_verified", "provider": provider.provider_name,
                                  "model": response.model, "model_is_alias": response.model.endswith("-latest"),
                                  "usage": response.usage.model_dump()}
        except (ProviderFailure, TimeoutError) as exc:
            report["decision"] = exc.code if isinstance(exc, ProviderFailure) else "provider_timeout"
    if report["meta_configured"]:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                async with asyncio.timeout(20):
                    response = await client.post("https://api.meta.ai/v1/responses",
                        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
                        json={"model": os.environ.get("META_MODEL", "muse-spark-1.3"),
                              "input": "Reply with the single word ready.", "max_output_tokens": 64})
            report["meta"] = {"http_status": response.status_code,
                              "status": "reachable" if response.is_success else "request_failed"}
        except (httpx.HTTPError, TimeoutError):
            report["meta"] = "connection_failed"
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Make tiny paid API calls with synthetic inputs")
    parser.add_argument("--init-db", action="store_true", help="Create the new learning tables in the configured database")
    args = parser.parse_args()
    load_environment()
    print(json.dumps(asyncio.run(preflight(args.live, args.init_db)), indent=2))
