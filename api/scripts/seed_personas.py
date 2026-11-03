"""Build the demo-persona templates into the learning database (deterministic, idempotent, no paid calls).

Each template lives under a fixed owner with no cookie, so nobody can sign in as it. Viewers never use the
template rows: "Try as…" builds the same fixture into a private copy. A second run changes nothing.

    api\\.venv\\Scripts\\python.exe api\\scripts\\seed_personas.py            (local SQLite)
    set LEARNING_DATABASE_URL=... before it to seed another database.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from learning import personas  # noqa: E402
from learning.storage import CaptureStore, local_database_url, make_engine  # noqa: E402


def main() -> int:
    store = CaptureStore(make_engine(os.environ.get("LEARNING_DATABASE_URL") or local_database_url()))
    store.initialize()
    builder = personas.PersonaStore(store)
    for key in personas.KEYS:
        owner = personas.template_owner(key)
        result = builder.build(owner, key)
        print(json.dumps({**result, **personas.summary(builder, owner)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
