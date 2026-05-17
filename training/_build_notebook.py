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
# Y · Gemma-3n-E2B QLoRA on ControlSketch-Part

This notebook fine-tunes **`unsloth/gemma-3n-E2B-it`** on the part-structured
SVG instruction dataset built by `training/prepare_dataset.py`. It targets
the **Gemma 4 Good Hackathon** (Future-of-Education + Unsloth tracks).

The output is a LoRA adapter the agent can drop into Ollama to serve the
edge-fine-tuned variant alongside the base E4B model.

**Runtime: free Kaggle T4 (~ 30–45 min for 2 epochs).**

Steps:
1. Install Unsloth (with Kaggle's pre-pinned `xformers` / `bitsandbytes`).
2. Load Gemma-3n-E2B in 4-bit.
3. Wrap with QLoRA adapters (r=16, alpha=32).
4. Apply the Gemma-3 chat template to our `svg_lessons.jsonl`.
5. Train 2 epochs.
6. Sanity-check inference on a held-out chemistry prompt.
7. Save LoRA + (optional) push to HF + (optional) export GGUF.

**Why Gemma-3n-E2B?** It's the smallest officially supported Unsloth Gemma
target that fits T4 VRAM and runs locally on the project's RTX 5060 8 GB once
quantised. The hackathon's "Gemma 4" branding is on top of the Gemma-3n
family — the model tag in Ollama is `gemma3n:e2b` and it is the same weights
served as `gemma-4-E2B` on Google AI Studio.
"""),
    md("""
## 1 · Install dependencies

If running on Kaggle, enable **GPU T4 x1** in Settings → Accelerator. The
install below pulls Unsloth's pinned wheel set; on Colab use the official
free notebook cell instead.
"""),
    code("""
%%capture
import os, sys
# Kaggle's preinstalled torch/cuda is fine; just install Unsloth itself.
!pip install --no-deps "unsloth[kaggle-new] @ git+https://github.com/unslothai/unsloth.git"
!pip install --no-deps unsloth_zoo
!pip install --no-deps "trl==0.15.0" "accelerate==0.34.2" "peft==0.12.0" "bitsandbytes==0.43.3"
!pip install datasets==2.21.0 "transformers>=4.51.0,<4.56.0"
"""),
    md("""
## 2 · Load Gemma-3n-E2B in 4-bit
"""),
    code("""
import torch
from unsloth import FastModel

MAX_SEQ_LEN = 4096

model, tokenizer = FastModel.from_pretrained(
    model_name="unsloth/gemma-3n-E2B-it",
    max_seq_length=MAX_SEQ_LEN,
    load_in_4bit=True,
    full_finetuning=False,
)

torch.cuda.empty_cache()
"""),
    md("""
## 3 · Add QLoRA adapters

We only fine-tune the language layers; the vision / audio towers stay frozen.
Hyper-params follow the plan: `r=16`, `alpha=32`, no dropout.
"""),
    code("""
model = FastModel.get_peft_model(
    model,
    finetune_vision_layers=False,
    finetune_audio_layers=False,
    finetune_language_layers=True,
    finetune_attention_modules=True,
    finetune_mlp_modules=True,
    r=16,
    lora_alpha=32,
    lora_dropout=0.0,
    bias="none",
    random_state=3407,
)
"""),
    md("""
## 4 · Apply chat template + load `svg_lessons.jsonl`

Mount your prepared JSONL by either uploading it as a Kaggle Dataset (e.g.
`y-svg-lessons`) or by setting `DATASET_PATH` to the HF dataset id you
pushed via `prepare_dataset.py --push-hf …`.
"""),
    code("""
from unsloth.chat_templates import get_chat_template
from datasets import load_dataset
from pathlib import Path

tokenizer = get_chat_template(tokenizer, chat_template="gemma-3")

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
def format_row(example):
    msgs = example["messages"]
    text = tokenizer.apply_chat_template(
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
assistant tokens; the long system prompt is masked out.
"""),
    code("""
from trl import SFTTrainer, SFTConfig
from unsloth.chat_templates import train_on_responses_only

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
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
import textwrap

system_prompt = ds[0]["messages"][0]["content"]  # same prompt the trainer saw
test_user = "Draw a benzene ring with alternating bonds, decomposing into named parts."

messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": test_user},
]
inputs = tokenizer.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=True,
    return_tensors="pt",
    return_dict=True,
).to("cuda")

from transformers import TextStreamer
streamer = TextStreamer(tokenizer, skip_prompt=True)
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
between sessions and lets you download the artefact.
"""),
    code("""
LORA_DIR = "y-gemma3n-svg-lora"
model.save_pretrained(LORA_DIR)
tokenizer.save_pretrained(LORA_DIR)
print("saved adapter →", LORA_DIR)
"""),
    md("""
### 7a · Push to Hugging Face (optional)

Uncomment after running `from huggingface_hub import login; login("HF_TOKEN")`.
"""),
    code("""
# from huggingface_hub import login
# login("YOUR_HF_TOKEN")
# HF_REPO = "yourname/y-gemma3n-svg-lora"
# model.push_to_hub(HF_REPO, token=True)
# tokenizer.push_to_hub(HF_REPO, token=True)
# print("pushed →", HF_REPO)
"""),
    md("""
## 8 · GGUF export for Ollama (optional)

Saves a single q4_k_m GGUF that the next phase (`models/Modelfile.y-gemma4`)
will reference for `ollama create y-gemma4 -f ...`.

This step is the most fragile because llama.cpp's Gemma-3n converter has
known issues; if it fails, ship the LoRA on HF as the primary deliverable
and stay on `gemma3n:e2b` upstream for the Ollama leg of the demo.
"""),
    code("""
# model.save_pretrained_gguf(
#     "y-gemma3n-svg-q4_k_m",
#     tokenizer,
#     quantization_method="q4_k_m",
# )
# print("wrote y-gemma3n-svg-q4_k_m/y-gemma3n-svg-q4_k_m.gguf")
"""),
    md("""
## 9 · Reproducibility

* Base model: `unsloth/gemma-3n-E2B-it` (≈ 5.4 B effective params, 4-bit).
* Dataset: 400 rows of `duxiaodan/ControlSketch-Part`, distilled by
  `training/prepare_dataset.py` into `[text:] / [draw_part: …] / [/draw_part]`
  blocks.
* QLoRA: r=16, α=32, dropout=0, no bias, target=language+attention+mlp.
* Optimiser: AdamW-8-bit, lr=2e-4, linear schedule, 10 warmup steps,
  weight-decay=0.01.
* Training: 2 epochs (~ 100 steps) on a free T4. Loss starts in the 6–8 band
  for Gemma-3n (per Unsloth's docs, this is expected) and falls to ~ 1.0–1.5.
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
