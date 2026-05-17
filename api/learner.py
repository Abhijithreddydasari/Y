"""Latent learner-knowledge model.

A lightweight per-user store that captures what each student has touched,
mastered, and struggled with across sessions. Persists as JSON on disk so it
survives restarts. Each session is also embedded with `nomic-embed-text` (via
Ollama) so the frontend can plot a trail through concept space (UMAP).

Two-call architecture:
  - extract_concepts(lesson_text) -> {seen, mastered, struggling, summary}
    A small Gemma call asks the model to label the lesson concepts.
  - embed(text) -> List[float]
    Calls Ollama embeddings on `nomic-embed-text` (768d).

The session record is appended to data/learners/{user_id}.json. The next
lesson's system prompt is prepended with a 1-3 line summary of the user's
mastery so Y calibrates depth (skips already-mastered basics, doubles down
on struggling areas).

This is *explicitly framed as a sketch*. A production grade learner model
would use proper Bayesian Knowledge Tracing (DKT). We ship the architecture
and the demo loop in 3 hours; the writeup names what is sketch and what
isn't.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import ollama


_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "learners"
DATA_DIR = Path(os.environ.get("LEARNER_STORE_DIR", "")).expanduser() if os.environ.get("LEARNER_STORE_DIR") else _DEFAULT_DATA_DIR
DATA_DIR.mkdir(parents=True, exist_ok=True)

EMBED_MODEL_DEFAULT = "nomic-embed-text"


EXTRACT_SYSTEM_PROMPT = """You are an instructional analyst.

You will receive the raw text of a whiteboard lesson a tutor just delivered. Your job is to extract a structured summary of what concepts the lesson covered.

Reply with a SINGLE valid JSON object, nothing else (no markdown, no commentary, no code fences). Schema:

{
  "topic": "<one short phrase, 2-5 words, naming the main topic>",
  "concepts_seen": [array of 2-6 short concept names, lowercase, hyphenated where useful, e.g. \"pythagorean-theorem\", \"force-decomposition\", \"dfs-traversal\"],
  "mastered": [subset of concepts_seen the student likely understood after this lesson; empty if unsure],
  "struggling": [subset of concepts_seen where the student visibly stumbled or which the tutor flagged as tricky],
  "summary": "<one short sentence describing what was taught>"
}

Each concept name should be 1-3 words. Be concrete (\"benzene-aromaticity\", \"newton-second-law\"), not generic (\"physics\", \"chemistry\").
"""


@dataclass
class SessionRecord:
    ts: str
    topic: str
    primitives_count: int
    concepts_seen: list[str] = field(default_factory=list)
    mastered: list[str] = field(default_factory=list)
    struggling: list[str] = field(default_factory=list)
    summary: str = ""
    embedding: list[float] = field(default_factory=list)


@dataclass
class LearnerProfile:
    user_id: str
    sessions: list[dict] = field(default_factory=list)

    def mastery_summary(self, max_items: int = 6) -> dict[str, list[str]]:
        """Aggregate per-concept mastery across sessions.

        A concept is considered "mastered" if it appears in mastered more
        often than in struggling across the last N sessions. "Struggling" if
        the inverse. "Seen" if it has been encountered but neither mastered
        nor struggling has a clear majority.
        """
        seen_count: dict[str, int] = {}
        mastered_count: dict[str, int] = {}
        struggling_count: dict[str, int] = {}
        for s in self.sessions[-20:]:
            for c in s.get("concepts_seen") or []:
                seen_count[c] = seen_count.get(c, 0) + 1
            for c in s.get("mastered") or []:
                mastered_count[c] = mastered_count.get(c, 0) + 1
            for c in s.get("struggling") or []:
                struggling_count[c] = struggling_count.get(c, 0) + 1

        mastered: list[str] = []
        struggling: list[str] = []
        seen: list[str] = []
        for c, n in seen_count.items():
            m = mastered_count.get(c, 0)
            s = struggling_count.get(c, 0)
            if m > s and m > 0:
                mastered.append(c)
            elif s > m and s > 0:
                struggling.append(c)
            else:
                seen.append(c)
        # Cap each list and prefer the most-seen concepts.
        def top(seq: list[str]) -> list[str]:
            return sorted(seq, key=lambda c: -seen_count.get(c, 0))[:max_items]
        return {
            "mastered": top(mastered),
            "struggling": top(struggling),
            "seen": top(seen),
        }


class LearnerStore:
    """File-backed per-user learner profile store. JSON on disk; in-memory cache."""

    def __init__(self, root: Path = DATA_DIR, embed_model: str = EMBED_MODEL_DEFAULT) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, LearnerProfile] = {}
        self._embed_model = embed_model
        self._client: ollama.Client | None = None

    def _path(self, user_id: str) -> Path:
        safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", user_id)[:48] or "anon"
        return self.root / f"{safe}.json"

    def get(self, user_id: str) -> LearnerProfile:
        if user_id in self._cache:
            return self._cache[user_id]
        p = self._path(user_id)
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                profile = LearnerProfile(
                    user_id=user_id,
                    sessions=data.get("sessions", []),
                )
            except Exception:
                profile = LearnerProfile(user_id=user_id)
        else:
            profile = LearnerProfile(user_id=user_id)
        self._cache[user_id] = profile
        return profile

    def _save(self, profile: LearnerProfile) -> None:
        p = self._path(profile.user_id)
        p.write_text(
            json.dumps({"user_id": profile.user_id, "sessions": profile.sessions}, indent=2),
            encoding="utf-8",
        )

    def append_session(self, user_id: str, record: SessionRecord) -> None:
        profile = self.get(user_id)
        profile.sessions.append(record.__dict__)
        self._save(profile)

    def system_prompt_prefix(self, user_id: str) -> str:
        """Return a short string suitable for prepending to the system prompt.

        Empty for first-time users. For returning users it surfaces the
        teacher's mental model of the student.
        """
        profile = self.get(user_id)
        if not profile.sessions:
            return ""
        m = profile.mastery_summary()
        parts: list[str] = []
        if m["mastered"]:
            parts.append(f"already mastered: {', '.join(m['mastered'])}")
        if m["struggling"]:
            parts.append(f"recently struggled with: {', '.join(m['struggling'])}")
        if m["seen"]:
            parts.append(f"has seen: {', '.join(m['seen'])}")
        if not parts:
            return ""
        body = "; ".join(parts)
        return (
            "# Learner profile\n\n"
            f"This learner has previously {body}. "
            "Calibrate depth: skip basics they already mastered, slow down on struggling concepts, "
            "and connect new ideas to mastered ones.\n\n---\n\n"
        )

    # --- network calls ---------------------------------------------------

    def _ollama(self) -> ollama.Client:
        import os
        if self._client is None:
            self._client = ollama.Client(host=os.environ.get("OLLAMA_HOST", "http://localhost:11434"))
        return self._client

    async def extract_concepts(
        self,
        lesson_text: str,
        teacher_model: str,
    ) -> dict:
        """Run a small Gemma extraction over the lesson text. Returns
        {topic, concepts_seen, mastered, struggling, summary}.
        """
        loop = asyncio.get_running_loop()
        client = self._ollama()

        def producer() -> str:
            try:
                resp = client.generate(
                    model=teacher_model,
                    prompt=f"Lesson the tutor just delivered:\n\n{lesson_text}\n\nReturn the JSON now.",
                    system=EXTRACT_SYSTEM_PROMPT,
                    stream=False,
                    options={"temperature": 0.2, "num_predict": 384},
                )
                return str(resp.get("response", ""))
            except Exception as exc:
                return f"__error__:{exc}"

        raw = await loop.run_in_executor(None, producer)
        if raw.startswith("__error__:"):
            return _empty_extract()
        return _parse_extract_json(raw)

    async def embed(self, text: str) -> list[float]:
        """Embed `text` via Ollama's embeddings endpoint. Returns 768d
        vector or an empty list on failure."""
        loop = asyncio.get_running_loop()
        client = self._ollama()

        def producer():
            try:
                resp = client.embeddings(model=self._embed_model, prompt=text)
                return list(resp.get("embedding", []))
            except Exception:
                return []

        return await loop.run_in_executor(None, producer)

    async def update(
        self,
        user_id: str,
        lesson_text: str,
        primitives_count: int,
        teacher_model: str,
    ) -> SessionRecord:
        """End-of-lesson hook. Extracts concepts, embeds the lesson, persists.

        Designed to be fire-and-forget from the SSE handler.
        """
        if not lesson_text.strip():
            extract = _empty_extract()
        else:
            extract = await self.extract_concepts(lesson_text, teacher_model)
        embedding = await self.embed(lesson_text[:4000]) if lesson_text else []
        record = SessionRecord(
            ts=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            topic=str(extract.get("topic", "")),
            primitives_count=primitives_count,
            concepts_seen=list(extract.get("concepts_seen", [])),
            mastered=list(extract.get("mastered", [])),
            struggling=list(extract.get("struggling", [])),
            summary=str(extract.get("summary", "")),
            embedding=embedding,
        )
        self.append_session(user_id, record)
        return record


def _empty_extract() -> dict:
    return {
        "topic": "",
        "concepts_seen": [],
        "mastered": [],
        "struggling": [],
        "summary": "",
    }


def _parse_extract_json(raw: str) -> dict:
    if not raw:
        return _empty_extract()
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return _coerce_extract(json.loads(cleaned))
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    while start != -1:
        depth = 0
        for end in range(start, len(cleaned)):
            ch = cleaned[end]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    chunk = cleaned[start:end + 1]
                    try:
                        return _coerce_extract(json.loads(chunk))
                    except json.JSONDecodeError:
                        break
        start = cleaned.find("{", start + 1)
    return _empty_extract()


def _coerce_extract(d: object) -> dict:
    if not isinstance(d, dict):
        return _empty_extract()

    def as_list(v: object) -> list[str]:
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        if isinstance(v, str):
            return [v.strip()]
        return []

    return {
        "topic": str(d.get("topic", "")).strip(),
        "concepts_seen": as_list(d.get("concepts_seen") or d.get("concepts")),
        "mastered": as_list(d.get("mastered")),
        "struggling": as_list(d.get("struggling") or d.get("struggled_with")),
        "summary": str(d.get("summary", "")).strip(),
    }
