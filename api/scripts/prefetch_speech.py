"""Prefetch only Y's two Kokoro voices, audit assets, and write their hashes."""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from speech import get_speech_engine


async def main() -> None:
    engine = get_speech_engine()
    await engine.prefetch()
    lock = engine.write_asset_lock()
    print(json.dumps({"lock": str(lock), "health": engine.health(), "audit": engine.audit_assets()}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
