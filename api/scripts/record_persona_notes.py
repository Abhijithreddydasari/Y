"""Record each persona session's teaching notes and links once from Muse Spark 1.3 (live, paid: 21 calls).

Builds every persona into a scratch in-memory database; at each session close it sends the close route's
own evidence payload and notes prompt to Muse Spark 1.3 and keeps the raw answer. Cited observation ids are
stored as '#j' (the session's j-th check), so the seed can map them onto any owner's ids. Output:
api/learning/fixtures/personas/<key>.notes.json. The seed then replays these notes with no model call.

    api\\.venv\\Scripts\\python.exe api\\scripts\\record_persona_notes.py   (needs MODEL_API_KEY in .env)
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from learning import personas, profile  # noqa: E402
from learning.consolidate import MAX_TOKENS, SCHEMA, SYSTEM, evidence_payload  # noqa: E402
from learning.storage import CaptureStore, make_engine  # noqa: E402
from learning.tutor_models import META_BASE  # noqa: E402

MODEL = "muse-spark-1.3"


def load_env() -> None:
    env = Path(__file__).resolve().parents[2] / ".env"
    for line in env.read_text(encoding="utf-8").splitlines() if env.exists() else ():
        name, sep, value = line.partition("=")
        if sep and not line.lstrip().startswith("#"):
            os.environ.setdefault(name.strip(), value.strip().strip('"'))


def main() -> int:
    load_env()
    key = os.environ.get("MODEL_API_KEY", "").strip()
    if not key:
        print("MODEL_API_KEY is not set")
        return 1
    client = httpx.Client(timeout=httpx.Timeout(60, connect=5))
    for name in (sys.argv[1:] or personas.KEYS):
        store = CaptureStore(make_engine("sqlite://"))
        store.initialize()
        builder = personas.PersonaStore(store)
        sessions, timings = [], []

        def record(index, found, sid, known):
            previous, idx = builder.profiles.latest(owner)
            draft, _ = profile.reduce(previous, idx, found, sid)
            touched = {(o.concept, o.dimension) for o in found}
            beliefs = [{"concept": b.concept, "dimension": b.dimension, "mean": round(b.mean, 3)}
                       for b in draft.beliefs if (b.concept, b.dimension) in touched]
            payload = evidence_payload(found, builder.evidence.answers(sid), beliefs, tuple(known))
            body = {"model": MODEL, "max_tokens": MAX_TOKENS, "reasoning_effort": "low", "response_format": SCHEMA,
                    "messages": [{"role": "system", "content": SYSTEM},
                                 {"role": "user", "content": "SESSION EVIDENCE\n" + json.dumps(payload, ensure_ascii=False)}]}
            started = time.perf_counter()
            response = client.post(f"{META_BASE}/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"})
            timings.append(round((time.perf_counter() - started) * 1000))
            response.raise_for_status()
            raw = json.loads(response.json()["choices"][0]["message"]["content"] or "{}")
            ref = {str(o.observation_id): "#" + o.check_id.rsplit(".", 1)[-1] for o in found}
            sessions.append({
                "notes": [{"text": n["text"], "cites": [ref[c] for c in n["cites"] if c in ref]} for n in raw.get("notes", [])],
                "links": [{**k, "cites": [ref[c] for c in k["cites"] if c in ref]} for k in raw.get("links", [])]})
            return raw

        owner = personas.template_owner(name)
        personas.load.cache_clear()
        builder.build(owner, name, notes_source=record)
        out = personas.FIXTURES / f"{name}.notes.json"
        out.write_text(json.dumps({"model": MODEL, "recorded_at": time.strftime("%Y-%m-%d"), "sessions": sessions},
                                  ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(name, "sessions", len(sessions), "notes", sum(len(s["notes"]) for s in sessions),
              "links", sum(len(s["links"]) for s in sessions), "ms", timings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
