"""Build training/unsloth_train.ipynb from declarative cell definitions.

This is checked-in only as a maintenance helper; the actual artefact is the
notebook it produces. Run:

    python training/_build_notebook.py

to regenerate. Keeping the cell sources in Python makes the notebook
diff-friendly and avoids hand-editing the bulky .ipynb JSON.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "training" / "unsloth_train.ipynb"


def md(source: str) -> dict:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": [line + "\n" for line in source.strip("\n").splitlines()],
    }


def code(source: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [line + "\n" for line in source.strip("\n").splitlines()],
    }


CELLS: list[dict] = [
    md("""
# Y · Gemma 4 E4B QLoRA on ControlSketch-Part

This notebook fine-tunes **`unsloth/gemma-4-E4B-it`** on the part-structured
SVG instruction dataset built by `training/prepare_dataset.py`. It targets
the **Gemma 4 Good Hackathon** (Future-of-Education + Unsloth tracks).

The output is a LoRA adapter the agent can drop into Ollama to serve the
edge-fine-tuned variant alongside the base E4B model.

**Runtime: free Kaggle T4 (~ 45–60 min for 2 epochs at batch=2 / seq=4096).**

Steps:
1. Install Unsloth (with Kaggle's pre-pinned `xformers` / `bitsandbytes`).
2. Load Gemma 4 E4B in 4-bit.
3. Wrap with QLoRA adapters (r=16, alpha=32).
4. Apply the Gemma 4 chat template to our `svg_lessons.jsonl`.
5. Train 2 epochs.
6. Sanity-check inference on a held-out chemistry prompt.
7. Save LoRA + (optional) push to HF + (optional) export GGUF.

**Why Gemma 4 E4B and not E2B?** The agent's vanilla "Edge" toolbar slot
already serves `gemma4:e4b`, so making the "Edge fine-tuned" slot E4B+LoRA
means the LoRA only has to add task quality on top of the same base — it
doesn't have to first claw back the gap from a smaller model. E4B in 4-bit
+ LoRA + activations at `batch=2 / seq=4096` lands at ~6–8 GB, comfortable
on a T4's 15 GB VRAM. Per Google's
[Gemma 4 launch post](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
the family is E2B / E4B / 26B-MoE / 31B-Dense; Unsloth supports the whole
family day-one.
"""),
    md("""
## 1 · Install dependencies

If running on Kaggle, enable **GPU T4 x2** in Settings → Accelerator (the
older single-T4 option has been retired; the second T4 will sit idle —
fine, this notebook is single-GPU).

**Why this install matters.** Kaggle's base image ships `transformers==5.0.0`,
which predates Gemma 4 support — its config registry doesn't know
`model_type: "gemma4"`. The fix is to pin **`transformers==5.5.0`** (the
first stable release with Gemma 4 support, and what Unsloth's own
[Gemma 4 E4B vision notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma4_(E4B)-Vision.ipynb)
uses) plus a small set of dep floors. We mirror Unsloth's official install
verbatim — they've already de-risked the version matrix for this exact
model.

After this cell finishes, **click Run → Restart & Run All** once so the
kernel re-imports the new `transformers` cleanly.
"""),
    code("""
%%capture
import os, re

# Kaggle / Colab both have torch preinstalled — match xformers to it.
import torch
v = re.match(r'[\\d]{1,}\\.[\\d]{1,}', str(torch.__version__)).group(0)
xformers = "xformers==" + {
    "2.10": "0.0.34",
    "2.9":  "0.0.33.post1",
    "2.8":  "0.0.32.post2",
}.get(v, "0.0.34")

# Pass 1: install the dependency floor (with resolver).
!pip install sentencepiece protobuf "datasets==4.3.0" "huggingface_hub>=0.34.0" hf_transfer

# Pass 2: install bleeding-edge code without disturbing the floor.
!pip install --no-deps unsloth_zoo bitsandbytes accelerate {xformers} peft trl triton unsloth
!pip install --no-deps --upgrade "torchao>=0.16.0"
!pip install --no-deps "transformers==5.5.0" "tokenizers>=0.22.0,<=0.23.0"
!pip install torchcodec
!pip install --no-deps --upgrade timm   # Gemma 4 vision/audio backbone

torch._dynamo.config.recompile_limit = 64

print("Install done. Click Run -> Restart & Run All so the kernel re-imports transformers.")
"""),
    md("""
### 1a · Verify the upgrade actually landed

Run this **after the kernel restart**, before importing Unsloth. You
should see `transformers  5.5.x` and `huggingface-hub  0.3x` or newer.
If `transformers` still shows `5.0.0`, the upgrade didn't apply —
re-run cell 1 and restart again.
"""),
    code("""
import importlib.metadata as md

for pkg in [
    "transformers",
    "huggingface-hub",
    "tokenizers",
    "unsloth",
    "unsloth_zoo",
    "trl",
    "accelerate",
    "peft",
    "bitsandbytes",
    "datasets",
    "timm",
    "torchao",
]:
    try:
        print(f"{pkg:>18}  {md.version(pkg)}")
    except md.PackageNotFoundError:
        print(f"{pkg:>18}  NOT INSTALLED")
"""),
    md("""
## 2 · Load Gemma 4 E4B in 4-bit

We load through **`FastVisionModel`** (not `FastLanguageModel` /
`FastModel`) for one specific reason: at inference time the agent feeds
the model a **PNG snapshot of the student's whiteboard** along with the
text prompt. Loading via `FastLanguageModel` would either drop the
vision tower or skip its weights — meaning the LoRA we save and the
GGUF we export would be language-only with no path to do `model.generate(image, prompt)`.
We'd ship a fine-tuned tutor that can't read the canvas.

This matches Unsloth's official
[Gemma 4 E4B vision notebook](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Gemma4_(E4B)-Vision.ipynb)
exactly (cell 7 there).

Unsloth aliases `unsloth/gemma-4-E4B-it` to its pre-quantised mirror
`unsloth/gemma-4-e4b-it-unsloth-bnb-4bit` — that's expected and what we
want. If the load fails, try one of:

* `unsloth/gemma-4-e4b-it-unsloth-bnb-4bit`  (the real underlying tag)
* `unsloth/gemma-4-e4b-it`                   (plain mirror)
* `google/gemma-4-E4B-it`                    (raw weights; Unsloth quantises on the fly)

`use_gradient_checkpointing="unsloth"` is set at load time (Unsloth's
custom impl, faster and lighter than the stock variant). It's the main
reason E4B + LoRA + activations fit on T4 at our seq length.

If you hit OOM, drop to `batch=1 / grad_accum=8` in cell 5 — effective
batch stays 8.
"""),
    code("""
import os
import torch
from huggingface_hub import hf_hub_download
from unsloth import FastVisionModel

# The model exists on HF, but Kaggle/Hub version mismatches can make
# Unsloth report "No config file found". Probe HF first so failures are
# explicit and so we can use the exact repo Kaggle can see.
MODEL_CANDIDATES = [
    "unsloth/gemma-4-e4b-it-unsloth-bnb-4bit",  # pre-quantized mirror; fastest path
    "unsloth/gemma-4-E4B-it",                   # Unsloth base alias
    "google/gemma-4-E4B-it",                    # raw Google weights; may need HF access approval
]

hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
MODEL_ID = None
last_error = None

for candidate in MODEL_CANDIDATES:
    try:
        path = hf_hub_download(
            repo_id=candidate,
            filename="config.json",
            token=hf_token,
            force_download=False,
        )
        print(f"Using {candidate}; config -> {path}")
        MODEL_ID = candidate
        break
    except Exception as exc:
        last_error = exc
        print(f"Could not access {candidate}: {type(exc).__name__}: {exc}")

if MODEL_ID is None:
    raise RuntimeError(
        "Could not access any Gemma 4 E4B model config from Hugging Face. "
        "Check Kaggle Internet=On, then optionally set HF_TOKEN if the repo "
        "requires gated access."
    ) from last_error

model, processor = FastVisionModel.from_pretrained(
    model_name = MODEL_ID,
    load_in_4bit = True,
    use_gradient_checkpointing = "unsloth",
    token = hf_token,
    use_exact_model_name = True,
)

torch.cuda.empty_cache()
"""),
    md("""
## 3 · Add QLoRA adapters — language layers only

LoRA targets need a careful pick. Even though we loaded the vision tower
in cell 2 (so it's available at inference), our **training** data is
text-only — every row in `svg_lessons.jsonl` is `{user: "Draw a rabbit,
decomposing into named parts.", assistant: "[draw_part: ...] ..."}`,
zero images. Two consequences:

1. **`finetune_vision_layers=False`** — there are no image inputs in
   our dataset, so there are no real gradients to flow through the
   vision encoder. Turning this on would either leave a wasted LoRA
   shell or, worse, corrupt Google's pretrained vision weights from
   spurious gradient noise.
2. **`finetune_audio_layers=False`** — same reason; we have no audio.
3. **`finetune_language_layers=True` + attention + MLP** — this is
   where the new behaviour actually has to land: the
   `[draw_part: ...] ... [/draw_part]` block syntax, valid path-data
   sequences (`M L H V C S Q T A Z`), pedagogical decomposition. All of
   it is sequence modelling, so all of it lives in the language tower.

Put differently: SVG is text. The model emits `<path d="M 200 80 ...">`
as token sequences; the OUTPUT renders to pixels somewhere downstream
but the model itself never sees those pixels. Vision capability stays
relevant for *reading* the student's canvas at inference (where it's
already pretrained and excellent), not for *writing* SVG.

Hyper-params follow the plan: `r=16, α=32, dropout=0`. We keep
`target_modules="all-linear"` per Unsloth's recipe — they handle picking
the right linear projections inside the language tower for us.
"""),
    code("""
model = FastVisionModel.get_peft_model(
    model,
    finetune_vision_layers     = False,   # no image inputs in our dataset
    finetune_audio_layers      = False,   # no audio inputs in our dataset
    finetune_language_layers   = True,
    finetune_attention_modules = True,
    finetune_mlp_modules       = True,

    r = 16,
    lora_alpha = 32,
    lora_dropout = 0,
    bias = "none",
    random_state = 3407,
    use_rslora = False,
    loftq_config = None,
    target_modules = "all-linear",
)
"""),
    md("""
## 4 · Apply chat template + load `svg_lessons.jsonl`

Mount your prepared JSONL by either uploading it as a Kaggle Dataset (e.g.
`y-svg-lessons`) or by setting `DATASET_PATH` to the HF dataset id you
pushed via `prepare_dataset.py --push-hf …`.
"""),
    code("""
from unsloth import get_chat_template
from datasets import load_dataset
from pathlib import Path

# Gemma 4 ships a fresh chat template. If your installed unsloth is older
# and doesn't know "gemma-4" yet, fall back to "gemma-3" (same
# `<start_of_turn>user/model<end_of_turn>` markers, training works fine).
try:
    processor = get_chat_template(processor, "gemma-4")
except Exception:
    processor = get_chat_template(processor, "gemma-3")

# Default Kaggle path (after `Add Data → y-svg-lessons`):
KAGGLE_PATH = Path("/kaggle/input/y-svg-lessons/svg_lessons.jsonl")
HF_DATASET_ID = "yourname/y-controlsketch-instruct"  # change after push_to_hub
LOCAL_PATH = Path("svg_lessons.jsonl")

if KAGGLE_PATH.exists():
    ds = load_dataset("json", data_files=str(KAGGLE_PATH), split="train")
elif LOCAL_PATH.exists():
    ds = load_dataset("json", data_files=str(LOCAL_PATH), split="train")
else:
    ds = load_dataset(HF_DATASET_ID, split="train")

print(f"loaded {len(ds)} rows; first row keys: {list(ds[0].keys())}")
"""),
    code("""
# Apply the chat template ourselves (text path) so we can use the regular
# SFTTrainer instead of UnslothVisionDataCollator. Our dataset is text-only
# (no images), so this is the cleaner path even though we loaded the model
# through FastVisionModel.

def format_row(example):
    msgs = example["messages"]
    text = processor.apply_chat_template(
        msgs,
        tokenize=False,
        add_generation_prompt=False,
    )
    return {"text": text}

ds = ds.map(format_row, num_proc=2)
print(ds[0]["text"][:500])
print("...")
print(ds[0]["text"][-400:])
"""),
    md("""
## 5 · Train

Plan hyper-params: `lr=2e-4`, `batch=2`, `grad_accum=4`, `epochs=2`. With
~400 rows that's roughly 100 optimiser steps — small but enough to teach the
`[draw_part]` block-output structure on top of an already-instruction-tuned
base.

We set `train_on_responses_only` so the loss is only computed on the
assistant tokens; the long system prompt is masked out. The trainer uses
`processor.tokenizer` (a plain text tokenizer) under the hood — the
vision tower is just along for the ride and gets no gradient updates
because `finetune_vision_layers=False` and there are no image tensors
in the batch.
"""),
    code("""
from trl import SFTTrainer, SFTConfig
from unsloth.chat_templates import train_on_responses_only

trainer = SFTTrainer(
    model=model,
    processing_class=processor.tokenizer,
    train_dataset=ds,
    eval_dataset=None,
    args=SFTConfig(
        dataset_text_field="text",
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_steps=10,
        num_train_epochs=2,
        max_steps=-1,
        learning_rate=2e-4,
        logging_steps=5,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=3407,
        output_dir="outputs",
        report_to="none",
        save_strategy="no",
    ),
)

trainer = train_on_responses_only(
    trainer,
    instruction_part="<start_of_turn>user\\n",
    response_part="<start_of_turn>model\\n",
)
trainer_stats = trainer.train()
"""),
    md("""
## 6 · Sanity-check inference

Generate one short response. With LoRA loaded, the model should emit our
`[text:]` + `[draw_part: ...] ... [/draw_part]` block format.
"""),
    code("""
system_prompt = ds[0]["messages"][0]["content"]  # same prompt the trainer saw
test_user = "Draw a benzene ring with alternating bonds, decomposing into named parts."

messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": test_user},
]
inputs = processor.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=True,
    return_tensors="pt",
    return_dict=True,
).to("cuda")

from transformers import TextStreamer
streamer = TextStreamer(processor.tokenizer, skip_prompt=True)
_ = model.generate(
    **inputs,
    max_new_tokens=512,
    temperature=0.7,
    top_p=0.95,
    top_k=64,
    streamer=streamer,
)
"""),
    md("""
## 7 · Save LoRA adapter

Local save (relative to the notebook's working dir). Kaggle keeps `Outputs/`
between sessions and lets you download the artefact. We save the
`processor` (which carries both the image processor and the tokenizer)
so the merged artefact stays multimodal — ready to read whiteboard PNGs
at inference time.
"""),
    code("""
LORA_DIR = "y-gemma4-svg-lora"
model.save_pretrained(LORA_DIR)
processor.save_pretrained(LORA_DIR)
print("saved adapter →", LORA_DIR)
"""),
    md("""
### 7a · Push to Hugging Face (optional)

Uncomment after running `from huggingface_hub import login; login("HF_TOKEN")`.
"""),
    code("""
# from huggingface_hub import login
# login("YOUR_HF_TOKEN")
# HF_REPO = "yourname/y-gemma4-svg-lora"
# model.push_to_hub(HF_REPO, token=True)
# processor.push_to_hub(HF_REPO, token=True)
# print("pushed →", HF_REPO)
"""),
    md("""
## 8 · GGUF export for Ollama (optional)

Saves a single `q4_k_m` GGUF that the next phase (`models/Modelfile.y-gemma4`)
will reference for `ollama create y-gemma4 -f ...`.

Gemma 4 has day-one llama.cpp support, so the export should "just work" on
recent llama.cpp builds. If it fails on Kaggle's pinned `llama-cpp-python`,
ship the LoRA + dataset on HF as the primary Unsloth-track deliverable and
let users merge to GGUF locally with `unsloth.save.save_to_gguf`.
"""),
    code("""
# model.save_pretrained_gguf(
#     "y-gemma4-svg-q4_k_m",
#     processor.tokenizer,
#     quantization_method="q4_k_m",
# )
# print("wrote y-gemma4-svg-q4_k_m/y-gemma4-svg-q4_k_m.gguf")
"""),
    md("""
## 9 · Reproducibility

* Base model: `unsloth/gemma-4-E4B-it` (~ 4 B effective params during
  inference, loaded 4-bit). Per Google's
  [Gemma 4 launch post](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
  E4B is the larger of the two edge-targeted Gemma 4 variants and matches
  the vanilla "Edge" tag (`gemma4:e4b`) the agent serves by default.
* Loaded through `FastVisionModel` (multimodal entry point) so the
  vision tower is preserved end-to-end. The agent passes whiteboard
  PNGs at inference; the saved adapter + processor remain multimodal.
* Dataset: 400 rows of `duxiaodan/ControlSketch-Part`, distilled by
  `training/prepare_dataset.py` into `[text:] / [draw_part: …] / [/draw_part]`
  blocks. Text-only — no image inputs in the training data.
* QLoRA: r=16, α=32, dropout=0, no bias.
  * `finetune_vision_layers=False`, `finetune_audio_layers=False` —
    no image / audio gradients available, so we don't perturb the
    pretrained encoders.
  * `finetune_language_layers=True`, `finetune_attention_modules=True`,
    `finetune_mlp_modules=True` — this is where the new
    `[draw_part]` block-output behaviour lives.
  * `target_modules="all-linear"` per Unsloth's recipe.
* Optimiser: AdamW-8-bit, lr=2e-4, linear schedule, 10 warmup steps,
  weight-decay=0.01.
* Training: 2 epochs (~ 100 steps) on a free T4 (~45–60 min).
* Eval: qualitative — the held-out benzene prompt should emit at least
  two well-formed `[draw_part]` blocks with sane viewBox and ≤ 8 path
  commands per part. Run `api/scripts/smoke_drawpart.py` against the
  re-served Ollama model to confirm.

The plan calls this the "Unsloth track" deliverable; the LoRA + the
prepared dataset on HF, both linked from the writeup, satisfy the track
requirements even if the GGUF export fails.
"""),
]


def main() -> None:
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
            "accelerator": "GPU",
            "colab": {"gpuType": "T4"},
        },
        "cells": CELLS,
    }
    OUT.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
