"""Convert duxiaodan/ControlSketch-Part into Y's part-structured instruction JSONL.

This is the data half of P6/P7 of the hackathon plan: distil ControlSketch-Part
into messages of the form

    [
      {"role": "system",    "content": <Y's tool-registry system prompt>},
      {"role": "user",      "content": "Draw a {category}, decomposing into named parts."},
      {"role": "assistant", "content": "[text: \"Let's start with the head.\"]\n
                                         [draw_part: name=\"head\" viewBox=\"0 0 512 512\"]\n
                                         M x0 y0 C x1 y1 x2 y2 x3 y3\n
                                         M ...\n
                                         [/draw_part]
                                         [text: \"Now the torso.\"]
                                         [draw_part: ...] ... [/draw_part]
                                         [text: \"That's a horse.\"]"}
    ]

so that an Unsloth QLoRA fine-tune on gemma-4-E2B-it teaches it the structure
of [draw_part] blocks and chains-of-narration.

Usage
-----
    # 400 training rows from the original train split
    python training/prepare_dataset.py --rows 400 \
        --output training/data/svg_lessons.jsonl

    # Push to HF (requires `huggingface_hub` and `huggingface-cli login`)
    python training/prepare_dataset.py --rows 400 \
        --output training/data/svg_lessons.jsonl \
        --push-hf <handle>/y-controlsketch-instruct

If the `datasets` package or the dataset itself is unreachable, the script
falls back to a small synthetic stand-in so the JSONL pipeline can still be
exercised end-to-end. This is useful for CI smoke tests in the absence of HF.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMPTS_DIR = ROOT / "api" / "prompts"
DEFAULT_OUTPUT = ROOT / "training" / "data" / "svg_lessons.jsonl"


# --------- system prompt ----------------------------------------------------

# We deliberately pass the model the SAME system prompt at training time and
# at inference time (api/teacher.py loads system.md + primitives.md + a few
# example files). For the training distillation we keep just system.md +
# primitives.md to stay under HF's 5MB-per-row practical budget; the per-row
# few-shot examples are in the assistant content itself, drawn from
# ControlSketch-Part.
SYSTEM_PROMPT_FILES = [
    PROMPTS_DIR / "system.md",
    PROMPTS_DIR / "primitives.md",
]


def load_system_prompt() -> str:
    parts: list[str] = []
    for p in SYSTEM_PROMPT_FILES:
        if not p.exists():
            print(f"[prepare_dataset] WARN missing prompt file: {p}", file=sys.stderr)
            continue
        parts.append(p.read_text(encoding="utf-8").strip())
    return "\n\n---\n\n".join(parts)


# --------- name shortening --------------------------------------------------

_TAIL_FUNCTION_WORDS = {
    "with", "and", "of", "the", "a", "an", "to", "for", "from", "in",
    "on", "at", "by", "into", "onto", "or", "featuring", "including",
    "comprising", "consisting", "such", "as", "that",
}


def short_part_name(desc: str, max_words: int = 5) -> str:
    """Turn 'head and neck facing left, featuring pointed ears, an eye, and a mane'
    into 'head and neck'. ControlSketch-Part labels are LLM-generated and long;
    for a whiteboard caption we want the head noun-phrase only.

    Strategy:
      - Cut at first comma / semicolon / colon (gets noun phrase).
      - Truncate to first ``max_words`` words.
      - Strip trailing function words ("with", "and", ...) so the narration
        template "Drawing the {short}." doesn't end with a dangling preposition.
    """
    if not desc:
        return ""
    head = desc.split(",")[0].split(";")[0].split(":")[0].strip()
    head = head.replace("\n", " ").strip()
    words = head.split()[:max_words]
    # Trim trailing prepositions / conjunctions ("with", "and", ...).
    while words and words[-1].lower().rstrip(".") in _TAIL_FUNCTION_WORDS:
        words.pop()
    # Trim trailing participles like "facing", "extending", "featuring" so the
    # narration "Drawing the X." reads as a noun phrase, not a verb fragment.
    while len(words) > 1:
        tail = words[-1].lower().rstrip(".,")
        if tail.endswith("ing") and tail not in {"king", "ring", "wing", "string", "spring"}:
            words.pop()
            continue
        break
    while words and words[-1].lower().rstrip(".") in _TAIL_FUNCTION_WORDS:
        words.pop()
    return " ".join(words)


# --------- stroke validity --------------------------------------------------

def stroke_is_meaningful(stroke: list[int], canvas: int = 512) -> bool:
    """Drop padding strokes (all zero) and out-of-canvas garbage."""
    if not stroke or len(stroke) < 8:
        return False
    if all(int(v) == 0 for v in stroke[:8]):
        return False
    # Reject coords way outside the [-canvas, 2*canvas] band — those are
    # dataset noise that yields a hopelessly off-screen path.
    lo = -canvas
    hi = 2 * canvas
    for v in stroke[:8]:
        if not (lo <= int(v) <= hi):
            return False
    return True


# --------- assistant content builder ----------------------------------------

def stroke_to_path_d(stroke: list[int]) -> str:
    x0, y0, x1, y1, x2, y2, x3, y3 = (int(v) for v in stroke[:8])
    return f"M {x0} {y0} C {x1} {y1} {x2} {y2} {x3} {y3}"


def build_assistant_content(
    *, category: str, parts: list[str], path_data: list[list[int]],
    path_assignment: list[int], view_box: str = "0 0 512 512",
) -> str | None:
    """Assemble the [text:]/[draw_part] sequence the model is meant to emit.

    Returns None when the row has no usable strokes / parts after filtering,
    so the caller can drop it.
    """
    if not parts:
        return None
    by_part: dict[int, list[str]] = {i: [] for i in range(len(parts))}
    for stroke, part_idx in zip(path_data, path_assignment):
        if not stroke_is_meaningful(stroke):
            continue
        idx = int(part_idx)
        if idx < 0 or idx >= len(parts):
            continue
        by_part[idx].append(stroke_to_path_d(stroke))

    nonempty = [(i, by_part[i]) for i in range(len(parts)) if by_part[i]]
    if not nonempty:
        return None

    short_cat = category.replace("_", " ")
    lines: list[str] = [f'[text: "Let\'s draw a {short_cat}."]']
    for idx, paths in nonempty:
        full = parts[idx].strip()
        short = short_part_name(full) or f"part {idx + 1}"
        # Use the short name (always 1-5 noun-phrase words after trimming
        # trailing prepositions) for both narration and the [draw_part] name.
        # The full original description tends to be 12+ words, which forces
        # the model to imitate a too-long part name; we'd rather it learn
        # short, snappy ones that match our hand-written few-shots.
        lines.append(f'[text: "Drawing the {short}."]')
        safe = short.replace('"', "'")
        lines.append(f'[draw_part: name="{safe}" viewBox="{view_box}"]')
        lines.extend(paths)
        lines.append("[/draw_part]")
    lines.append(f'[text: "That\'s a {short_cat}."]')
    return "\n".join(lines)


# --------- main pipeline ----------------------------------------------------

def iter_dataset_rows(split: str, n: int, seed: int):
    """Yield raw rows from ControlSketch-Part. Falls back to a small synthetic
    sample when the `datasets` package or the dataset itself is unavailable
    (offline / no auth). The synthetic fallback is enough to verify the
    output format end-to-end."""
    try:
        from datasets import load_dataset  # type: ignore
    except Exception as exc:
        print(
            f"[prepare_dataset] datasets package not installed ({exc}); using synthetic fallback. "
            "Install on Kaggle/Colab via `pip install datasets`.",
            file=sys.stderr,
        )
        yield from _synthetic_rows()
        return

    try:
        ds = load_dataset("duxiaodan/ControlSketch-Part", split=split)
    except Exception as exc:
        print(
            f"[prepare_dataset] could not load duxiaodan/ControlSketch-Part:{split} ({exc}); "
            "using synthetic fallback.",
            file=sys.stderr,
        )
        yield from _synthetic_rows()
        return

    indices = list(range(len(ds)))
    rng = random.Random(seed)
    rng.shuffle(indices)
    yielded = 0
    for i in indices:
        if yielded >= n:
            break
        row = ds[i]
        yielded += 1
        yield row


def _synthetic_rows():
    """Three handcrafted rows that look like ControlSketch-Part rows. They let
    smoke-tests of the prepared JSONL run without internet access."""
    yield {
        "category": "horse",
        "sketch_id": "horse_synth_0",
        "parts": [
            "head and neck facing left",
            "torso with curved back and belly",
            "two legs",
            "tail extending from the rear",
        ],
        "path_data": [
            [200, 100, 240, 80, 280, 120, 320, 110],
            [320, 110, 360, 130, 380, 180, 360, 220],
            [360, 220, 320, 280, 280, 320, 240, 320],
            [240, 320, 220, 280, 200, 240, 200, 200],
            [400, 220, 420, 240, 430, 260, 440, 280],
        ] + [[0, 0, 0, 0, 0, 0, 0, 0]] * 27,
        "path_assignment": [0, 0, 1, 1, 3] + [0] * 27,
        "short_caption": "A horse with a curved torso facing left.",
    }
    yield {
        "category": "cat",
        "sketch_id": "cat_synth_0",
        "parts": ["round head with two ears", "body and legs", "tail"],
        "path_data": [
            [180, 120, 200, 100, 220, 100, 240, 120],
            [240, 120, 260, 140, 260, 180, 240, 200],
            [240, 200, 280, 220, 320, 240, 360, 260],
            [180, 220, 200, 260, 220, 280, 240, 280],
        ] + [[0, 0, 0, 0, 0, 0, 0, 0]] * 28,
        "path_assignment": [0, 0, 1, 2] + [0] * 28,
        "short_caption": "A small cat in profile.",
    }
    yield {
        "category": "bicycle",
        "sketch_id": "bicycle_synth_0",
        "parts": ["front wheel", "rear wheel", "frame"],
        "path_data": [
            [120, 280, 120, 240, 160, 220, 200, 260],
            [200, 260, 200, 300, 160, 320, 120, 280],
            [320, 280, 320, 240, 360, 220, 400, 260],
            [400, 260, 400, 300, 360, 320, 320, 280],
            [180, 220, 240, 180, 280, 180, 360, 220],
        ] + [[0, 0, 0, 0, 0, 0, 0, 0]] * 27,
        "path_assignment": [0, 0, 1, 1, 2] + [0] * 27,
        "short_caption": "A simple bicycle with two wheels and a frame.",
    }


def write_jsonl(out_path: Path, rows, system_prompt: str) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n_written = 0
    n_skipped = 0
    with out_path.open("w", encoding="utf-8") as f:
        for row in rows:
            try:
                category = str(row["category"])
                parts = list(row["parts"])
                path_data = [list(p) for p in row["path_data"]]
                path_assignment = list(row["path_assignment"])
            except (KeyError, TypeError) as exc:
                print(f"[prepare_dataset] skip malformed row: {exc}", file=sys.stderr)
                n_skipped += 1
                continue

            assistant = build_assistant_content(
                category=category,
                parts=parts,
                path_data=path_data,
                path_assignment=path_assignment,
            )
            if assistant is None:
                n_skipped += 1
                continue

            user = f"Draw a {category.replace('_', ' ')}, decomposing into named parts."
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": assistant},
                ]
            }
            f.write(json.dumps(payload, ensure_ascii=False))
            f.write("\n")
            n_written += 1
    print(f"[prepare_dataset] wrote {n_written} rows, skipped {n_skipped}", file=sys.stderr)
    return n_written


def maybe_push_to_hf(jsonl_path: Path, repo_id: str) -> None:
    try:
        from huggingface_hub import HfApi, login  # type: ignore
    except Exception as exc:
        print(f"[prepare_dataset] cannot push to HF ({exc}); install huggingface_hub.", file=sys.stderr)
        return
    api = HfApi()
    try:
        api.create_repo(repo_id=repo_id, repo_type="dataset", exist_ok=True)
    except Exception as exc:
        print(f"[prepare_dataset] HF create_repo failed ({exc}); make sure you ran `huggingface-cli login`.", file=sys.stderr)
        return
    try:
        api.upload_file(
            path_or_fileobj=str(jsonl_path),
            path_in_repo=jsonl_path.name,
            repo_id=repo_id,
            repo_type="dataset",
            commit_message="add y-svg-lessons jsonl",
        )
        print(f"[prepare_dataset] pushed {jsonl_path.name} to {repo_id}", file=sys.stderr)
    except Exception as exc:
        print(f"[prepare_dataset] HF upload failed: {exc}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=400, help="number of rows to sample")
    ap.add_argument("--split", default="train", choices=["train", "validation", "test"])
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    ap.add_argument("--push-hf", default="", help="HF dataset repo id (yourname/repo) to push to")
    args = ap.parse_args()

    system_prompt = load_system_prompt()
    if not system_prompt:
        print("[prepare_dataset] FATAL: system prompt files missing", file=sys.stderr)
        return 1

    rows = iter_dataset_rows(args.split, args.rows, args.seed)
    n = write_jsonl(args.output, rows, system_prompt)
    if n == 0:
        print("[prepare_dataset] no rows written", file=sys.stderr)
        return 2

    print(f"[prepare_dataset] OK -> {args.output} ({n} rows, "
          f"{args.output.stat().st_size / 1024:.1f} KiB)", file=sys.stderr)

    if args.push_hf:
        maybe_push_to_hf(args.output, args.push_hf)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
