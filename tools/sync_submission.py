"""Builds the hackathon repository (ask-Y) from this repository. Safe to re-run: the same input gives the same commits.

    python tools/sync_submission.py --out <empty or earlier output folder>

It does three things and never pushes:
  1. Foundation: a tag on this repo, built on the last pre-event commit. Commit A keeps only the pre-event files the
     app uses; commit B adds this week's edits to those files. `git diff A B` shows exactly those edits.
  2. Pin: writes submission/foundation.json and submission/.gitignore, and commits them here if they changed.
  3. Event repo: a filtered clone that keeps the real event commits but only files created during the event, plus
     submission/* moved to the root. It stops if any pre-event commit or file reaches the output.
Needs uv on PATH (runs git-filter-repo through uvx).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CUT = "9f0ca92eb8b2e768d754d7ab18ff724c75ce8025"  # last commit before the Oct 26 kickoff
KICKOFF = "2026-10-26T00:00:00+05:30"
ORIGINAL = "https://github.com/Abhijithreddydasari/Y.git"
EVENT_REPO = "https://github.com/Abhijithreddydasari/ask-Y.git"
OVERLAY = "submission/"
EXCLUDE_EVENT = ("docs/legacy/", ".claude/", "tools/", OVERLAY)  # docs/legacy is pre-event text under a new path
# Pre-event files outside web/ that the app, its tests or its docs still use.
FOUNDATION_API = {
    "api/pyproject.toml", "api/uv.lock", "api/speech.py", "api/speech_assets.lock.json", "api/transcription.py", "api/teacher.py",
    "api/parser.py", "api/validator.py", "api/salvage.py", "api/prompts/primitives.md", "api/prompts/system.md", "schema/primitives.json",
    "api/scripts/prefetch_speech.py", "api/scripts/test_teacher.py", "api/tests/test_speech.py",
    "THIRD_PARTY_NOTICES.md", "docs/architecture.md",
}
DROP_WEB = {"web/README.md", "web/scripts/test_sse_parser.mjs"}
IGNORE_BASE = """node_modules/
.venv/
__pycache__/
*.pyc
.next/
out/
dist/
build/
.env
.env.local
.env.*.local
.pytest_cache/
.vscode/
.idea/
*.log
.DS_Store
Thumbs.db
api/data/
data/
deploy/.env.modal
"""  # Never list foundation files here: Tailwind skips ignored files, and the board loses its sizing classes.


def git(*args: str, cwd: Path = ROOT, env: dict | None = None, check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                            env={**os.environ, **(env or {})})
    if check and result.returncode:
        sys.exit(f"git {' '.join(args)} failed:\n{result.stderr}")
    return result.stdout.strip()


def tree_paths(ref: str) -> set[str]:
    return set(git("ls-tree", "-r", "--name-only", ref).splitlines())


def split_paths() -> tuple[set[str], set[str]]:
    now, old = tree_paths("HEAD"), tree_paths(CUT)
    kept = now & old
    foundation = {p for p in kept if (p.startswith("web/") and p not in DROP_WEB) or p in FOUNDATION_API}
    missing = FOUNDATION_API - kept
    if missing:
        sys.exit(f"foundation files are gone from HEAD: {sorted(missing)}")
    event = {p for p in now - old if not p.startswith(EXCLUDE_EVENT)}
    return foundation, event


def tree_of(ref: str, paths: set[str]) -> str:
    """A tree holding only `paths` as they are at `ref`, built with a private index so the work tree is untouched."""
    entries = []
    for line in git("ls-tree", "-r", ref).splitlines():
        meta, path = line.split("\t", 1)
        mode, _kind, sha = meta.split()
        if path in paths:
            entries.append(f"{mode} {sha}\t{path}")
    with tempfile.TemporaryDirectory() as folder:
        env = {"GIT_INDEX_FILE": str(Path(folder, "index"))}
        # Bytes, not text: on Windows text mode would end each line in \r and git would drop every path.
        subprocess.run(["git", "update-index", "--add", "--index-info"], cwd=ROOT, input=("\n".join(entries) + "\n").encode("utf-8"),
                       env={**os.environ, **env}, check=True)
        tree = git("write-tree", env=env)
    count = len(git("ls-tree", "-r", "--name-only", tree).splitlines())
    if count != len(paths):
        sys.exit(f"foundation tree has {count} files, expected {len(paths)}")
    return tree


def commit(tree: str, parent: str, date: str, message: str) -> str:
    return git("commit-tree", tree, "-p", parent, "-m", message,
               env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})


def build_foundation(foundation: set[str]) -> tuple[str, str]:
    old_paths = foundation & tree_paths(CUT)
    date_a = git("log", "-1", "--format=%cI", CUT)
    base = commit(tree_of(CUT, old_paths), CUT, date_a, "foundation: keep only the pre-event files the event app uses")
    date_b = git("log", "-1", "--format=%cI", "HEAD", "--", *sorted(foundation))
    pinned = commit(tree_of("HEAD", foundation), base, date_b, "foundation: this week's edits to those files")
    tag = f"foundation-{pinned[:10]}"
    git("tag", "-f", tag, pinned)
    return base, tag


def write_overlay(foundation: set[str], base: str, tag: str) -> None:
    pin = {"repository": ORIGINAL, "tag": tag, "commit": git("rev-parse", tag), "pre_event_base": CUT, "kept_files_commit": base,
           "note": "Pre-event code this project builds on. kept_files_commit holds it as it was before the event; commit adds this week's edits."}
    overlay = ROOT / OVERLAY
    (overlay / "foundation.json").write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8", newline="\n")
    (overlay / ".gitignore").write_text(IGNORE_BASE, encoding="utf-8", newline="\n")
    git("add", "--", f"{OVERLAY}foundation.json", f"{OVERLAY}.gitignore")
    if git("diff", "--cached", "--name-only", "--", OVERLAY):
        git("commit", "-q", "-m", "chore: pin the foundation for the event repository", "--", f"{OVERLAY}foundation.json", f"{OVERLAY}.gitignore")


def on_rm_error(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def build_event(out: Path, event: set[str]) -> None:
    if out.exists():
        shutil.rmtree(out, onerror=on_rm_error)
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    git("clone", "-q", "--no-local", "--single-branch", "--branch", branch, str(ROOT), str(out), cwd=ROOT.parent)
    overlay = sorted(git("ls-tree", "-r", "--name-only", "HEAD", "--", OVERLAY).splitlines())
    # A rename line alone does not keep a path, so each overlay file is listed to keep it, then to move it.
    lines = sorted(event) + overlay + [f"{path}==>{path[len(OVERLAY):]}" for path in overlay]
    with tempfile.TemporaryDirectory() as folder:
        listing = Path(folder, "paths.txt")
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
        result = subprocess.run(["uvx", "git-filter-repo", "--force", "--paths-from-file", str(listing), "--prune-empty", "always",
                                 "--prune-degenerate", "always"], cwd=out, capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"git-filter-repo failed:\n{result.stderr[-800:]}")
    git("branch", "-M", "main", cwd=out)
    git("remote", "add", "origin", EVENT_REPO, cwd=out, check=False)


def verify(out: Path, foundation: set[str]) -> None:
    old = tree_paths(CUT)
    early = git("log", f"--until={KICKOFF}", "--format=%h %cI %s", cwd=out)
    ever = {p for p in git("log", "--name-only", "--format=", cwd=out).splitlines() if p}
    now = set(git("ls-tree", "-r", "--name-only", "HEAD", cwd=out).splitlines())
    # Overlay files take names the pre-event tree also used; their content here is rewritten, never the old file.
    allowed = {".gitignore", ".env.example", "README.md"}
    leaked = ((ever | now) & (old | foundation)) - allowed
    secrets = {p for p in now if Path(p).name in (".env", ".env.modal")}
    problems = []
    absent = {"README.md", ".env.example", ".gitignore", "foundation.json", "package.json", "scripts/setup.mjs", "api/learning/app.py"} - now
    if absent:
        problems.append(f"required files missing from the output: {sorted(absent)}")
    if early:
        problems.append(f"commits from before kickoff:\n{early}")
    if leaked:
        problems.append(f"pre-event files in the output: {sorted(leaked)[:12]}")
    if secrets:
        problems.append(f"secret files in the output: {sorted(secrets)}")
    if problems:
        sys.exit("STOPPED, not safe to push:\n" + "\n".join(problems))
    first = git("log", "--reverse", "--format=%h %ad %s", "--date=short", cwd=out).splitlines()[0]
    print(f"Verified: {git('rev-list', '--count', 'HEAD', cwd=out)} commits, {len(now)} files, first commit {first}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if git("status", "--porcelain", "--", ".", ":!submission/foundation.json", ":!submission/.gitignore", ":!.claude"):
        sys.exit("Commit or set aside your changes first: the sync reads committed files only.")
    foundation, event = split_paths()
    base, tag = build_foundation(foundation)
    write_overlay(foundation, base, tag)
    foundation, event = split_paths()
    build_event(args.out.resolve(), event)
    verify(args.out.resolve(), foundation)
    print(f"Foundation {tag}: {len(foundation)} files. Event repository: {len(event)} files plus the overlay.")
    print("\nTo publish, in CMD:")
    print(f"  git push origin {git('rev-parse', '--abbrev-ref', 'HEAD')} refs/tags/{tag}")
    print(f'  cd /d "{args.out.resolve()}"')
    print("  git push origin main")


if __name__ == "__main__":
    main()
