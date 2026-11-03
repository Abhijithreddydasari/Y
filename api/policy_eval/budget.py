"""Hard cap on paid calls, per-role counts and a call log without headers or keys."""
from __future__ import annotations

import json
import threading
import time
from collections import Counter
from pathlib import Path


class BudgetExceeded(RuntimeError):
    pass


class Budget:
    """Every paid attempt (first try or retry) reserves one call before it is sent.

    With a log path, calls already logged there count too, so a resumed run cannot pass the cap.
    """

    def __init__(self, cap: int, log_path: Path | None = None):
        self.cap, self.log_path = cap, log_path
        self.lock = threading.Lock()
        self.by_role: Counter[str] = Counter()
        self.tokens: dict[str, Counter[str]] = {}
        self.used = 0
        if log_path and log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    self._count(json.loads(line))

    def _count(self, entry: dict) -> None:
        self.used += 1
        role = entry["role"]
        self.by_role[role] += 1
        bucket = self.tokens.setdefault(f"{role}|{entry.get('model')}", Counter())
        for key, amount in (entry.get("usage") or {}).items():
            if isinstance(amount, int):
                bucket[key] += amount

    def reserve(self, role: str) -> None:
        with self.lock:
            if self.used >= self.cap:
                raise BudgetExceeded(f"call cap {self.cap} reached ({dict(self.by_role)})")
            self.used += 1
            self.by_role[role] += 1

    def record(self, role: str, model: str, status: str, ms: float, usage: dict | None = None) -> None:
        """Log one finished attempt; reserve() already counted it."""
        entry = {"at": round(time.time(), 2), "role": role, "model": model, "status": status, "ms": round(ms),
                 "usage": {k: v for k, v in (usage or {}).items() if isinstance(v, int)}}
        with self.lock:
            bucket = self.tokens.setdefault(f"{role}|{model}", Counter())
            for key, amount in entry["usage"].items():
                bucket[key] += amount
            if self.log_path:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                with self.log_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(entry) + "\n")

    def summary(self) -> dict:
        return {"cap": self.cap, "used": self.used, "by_role": dict(self.by_role),
                "tokens": {k: dict(v) for k, v in self.tokens.items()}}
