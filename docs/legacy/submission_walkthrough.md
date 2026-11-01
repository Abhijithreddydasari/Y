# Submission walkthrough — steps 1 → 4

A do-it-once, in-order recipe for the four manual items left in
`docs/submission_checklist.md`. Don't skip anything; the order matters
(the Kaggle notebook needs the dataset, HF needs the LoRA, etc.).

> Total time: ~3–4 hours wall-clock if Kaggle has GPU capacity. Most of
> that is the LoRA train (~30–45 min) and uploads.

---

## Step 1 — Train the LoRA on Kaggle (free T4)

### 1.1 Generate the dataset locally first

The notebook expects `svg_lessons.jsonl` to exist. Make it now, on your
laptop.

**One-shot setup** — the api venv is uv-managed and doesn't include
`pip` or the HF data libs. Install them with `uv` (also pre-installs the
`huggingface_hub` we'll need in step 2):

```powershell
cd "C:\Users\abhij\OneDrive\Desktop\Brain Labs\Coding\Y\api"
uv pip install "datasets>=2.21" "huggingface_hub>=0.25"
```

Now generate the JSONL:

```powershell
cd "C:\Users\abhij\OneDrive\Desktop\Brain Labs\Coding\Y"
.\api\.venv\Scripts\python.exe training\prepare_dataset.py --rows 400 --output training\data\svg_lessons.jsonl
```

Expected output (in stderr — PowerShell may flag it red, that's fine):

```
[prepare_dataset] wrote 400 rows, skipped 0
[prepare_dataset] OK -> training\data\svg_lessons.jsonl (400 rows, ~5.6 MiB)
```

**Sanity check.** Confirm you got the real dataset, not the synthetic
3-row stand-in (the script falls back to that if `datasets` isn't
installed, or HF is unreachable):

```powershell
.\api\.venv\Scripts\python.exe -c "import os,json; p=r'training\data\svg_lessons.jsonl'; n=sum(1 for _ in open(p,encoding='utf-8')); print('rows=',n,'MiB=',round(os.path.getsize(p)/1048576,1))"
```

You want `rows= 400` and `MiB= 5+`. Anything below ~50 rows means the
fallback fired — re-run after fixing the install / network.

### 1.2 Create a Kaggle Dataset for the JSONL

1. Go to <https://www.kaggle.com/datasets> → **New Dataset**.
2. Title: **`y-svg-lessons`** (the notebook hard-codes this path).
3. Drag-drop `training\data\svg_lessons.jsonl`.
4. Visibility: **Public** (we're fine with public; private would require
   a Pro account).
5. License: **CC0** is simplest.
6. Click **Create**. Copy the slug — it will look like
   `<your-kaggle-username>/y-svg-lessons`.

### 1.3 Upload the notebook

1. Go to <https://www.kaggle.com/code> → **New Notebook** → **Upload**.
2. Pick `training/unsloth_train.ipynb` from this repo.
3. Once it opens, in the right-side panel:
   * **Settings → Accelerator → GPU T4 x2** (Kaggle retired the single-T4
     option; the second GPU sits idle, that's fine — the notebook is
     single-GPU)
   * **Settings → Internet → On** (needed for `pip install unsloth`)
   * **Settings → Persistence → Variables and Files** (so the LoRA
     output survives session restarts)
4. **Add data** → search for `y-svg-lessons` → add your dataset. It
   mounts at `/kaggle/input/y-svg-lessons/svg_lessons.jsonl` which is
   exactly what cell 4 of the notebook checks first.

### 1.4 Run

`Run all`. Watch for three things:

* **Cell 1 (install)**: must finish without errors. Don't worry about
  the "you must restart the runtime" warnings — we handle that next.
* **Cell 2 (model load)**: if you see
  `KeyError: 'gemma4'` or
  `model type "gemma4"` not recognised, the Kaggle base image's
  `transformers==5.0.0` doesn't know about Gemma 4 yet. Cell 1 already
  force-reinstalls `transformers` from `main`, but the kernel may still
  hold the old import in memory — click **Run → Restart & Run All**
  once and it'll resolve.
  * If it still fails, the model alias may have shifted on HF. Edit
    cell 2 and try one of: `unsloth/gemma-4-e4b-it-unsloth-bnb-4bit`,
    `unsloth/gemma-4-e4b-it`, `google/gemma-4-E4B-it`.
* **Cell 5 (train)**: training loss should fall over the run. With 400
  rows and `epochs=2 / lr=2e-4`, expect ~100 optimiser steps and a
  decreasing-then-flattening loss curve. It does NOT need to drop to
  zero — we're teaching format adherence, not memorising paths. If you
  hit OOM at `batch=2`, change to `batch=1, grad_accum=8` in cell 5
  (effective batch stays 8).

### 1.5 Verify it learned the format

Cell 6 fires a benzene prompt. The output should contain at least
**one** `[draw_part: name="..." viewBox="..."]` block followed by
`<path d="..."/>` lines and a closing `[/draw_part]`. If it just emits
prose, training under-fit — re-run cell 5 with `num_train_epochs=4`
instead of 2 and try again.

### 1.6 Save the artefacts

* Cell 7 saves the LoRA to `y-gemma4-svg-lora/` inside the notebook's
  working directory. After Kaggle's session ends, find it under your
  notebook's **Output** tab and click **Download** (or skip this and
  push directly to HF in step 2).
* Cell 8 (optional) exports a GGUF. Uncomment it only if you've got
  time — it can take 10–20 min and sometimes runs out of disk on T4.

You now have:

```
y-gemma4-svg-lora/
  adapter_config.json
  adapter_model.safetensors
  tokenizer.json
  ...
```

That's the Unsloth-track deliverable.

---

## Step 2 — Push the LoRA (and dataset) to Hugging Face

You're right that public free storage is generous (~1 TB) — we'll use
public.

### 2.1 Create the HF account + token

1. Sign up at <https://huggingface.co/join> if you don't have an account.
2. <https://huggingface.co/settings/tokens> → **Create new token**:
   * Name: `y-hackathon`
   * Type: **Write** (we need to push)
   * Save the token somewhere private; you'll paste it twice.

### 2.2 Push the LoRA

Two paths — pick whichever is more convenient:

**Path A — straight from the Kaggle notebook (easiest).** In the
notebook, find cell **7a** ("Push to Hugging Face") and uncomment it:

```python
from huggingface_hub import login
login("hf_xxx_paste_your_token_here")
HF_REPO = "<your-hf-username>/y-gemma4-svg-lora"
model.push_to_hub(HF_REPO, token=True)
tokenizer.push_to_hub(HF_REPO, token=True)
print("pushed →", HF_REPO)
```

Re-run that one cell. Done.

**Path B — locally after downloading the LoRA.** From your laptop:

```powershell
cd "C:\Users\abhij\OneDrive\Desktop\Brain Labs\Coding\Y"
pip install huggingface_hub
huggingface-cli login                  # paste the token
huggingface-cli upload "<your-hf-username>/y-gemma4-svg-lora" .\path\to\downloaded\y-gemma4-svg-lora --repo-type=model
```

### 2.3 (Optional) Push the dataset too

The same `prepare_dataset.py` script can mirror the JSONL to HF:

```powershell
.\api\.venv\Scripts\python.exe training\prepare_dataset.py --rows 400 --output training\data\svg_lessons.jsonl --push-hf "<your-hf-username>/y-controlsketch-instruct"
```

Now you've got two public HF repos:

* `<you>/y-gemma4-svg-lora` — the LoRA adapter (Unsloth track)
* `<you>/y-controlsketch-instruct` — the dataset (reproducibility)

Add both links to:

* `README.md` — top table near the Kaggle/YouTube placeholders
* `docs/kaggle_writeup.md` — the same top section

### 2.4 (Optional) Build the local Ollama tag

If cell 8 in the notebook successfully wrote `y-gemma4-svg-q4_k_m.gguf`,
download it and:

```powershell
cd "C:\Users\abhij\OneDrive\Desktop\Brain Labs\Coding\Y"
copy <downloaded>\y-gemma4-svg-q4_k_m.gguf models\
ollama create y-gemma4 -f models\Modelfile.y-gemma4
ollama run y-gemma4 "Test"
```

The toolbar's **Edge fine-tuned (E4B+LoRA)** option should now light up
green when you reload the page.

If GGUF export failed, just stay on `gemma4:e4b` for the demo and ship
the LoRA on HF as the Unsloth-track artefact. Judges only need to be
able to **run** the training pipeline; the served-via-Ollama bit is
bonus.

---

## Step 3 — Wire up the Cloud teacher (Gemma 4 31B)

> "I hope I won't see Gemma 3 here, like I said focus is on Gemma 4" —
> confirmed, the cloud path is `gemma-4-31b-it` end-to-end. No Gemma 3.

### 3.1 Get a Google AI Studio key

1. <https://aistudio.google.com/apikey> → **Create API key**.
2. Copy the key (starts with `AIza...`).
3. Free tier covers a couple of dozen demo calls per day on Gemma 4 31B.
   Plenty for a hackathon submission.

### 3.2 Drop it in `.env`

If you don't have a `.env` yet:

```powershell
cd "C:\Users\abhij\OneDrive\Desktop\Brain Labs\Coding\Y"
copy .env.example .env
```

Open `.env` and uncomment / fill in:

```
GOOGLE_API_KEY=AIza...your_key_here
CLOUD_MODEL=gemma-4-31b-it
```

### 3.3 Install the cloud SDK (optional dep)

```powershell
cd api
.\.venv\Scripts\python.exe -m pip install "google-genai>=0.3.0"
```

(We made `google-genai` an optional dep so the default install stays
lean. Once it's in, the `CloudTeacher` will use it automatically.)

### 3.4 Verify

Restart uvicorn (so it picks up the new `.env`):

```powershell
cd api
.\.venv\Scripts\python.exe -m uvicorn main:app --port 8000
```

Then in a separate shell:

```powershell
curl http://127.0.0.1:8000/health
```

You should see `"cloud": { "kind": "cloud", "model": "gemma-4-31b-it",
"ready": true }`. The toolbar dropdown's **Cloud (Gemma 4 31B)** entry
will stop saying "not configured."

Smoke a single lesson on the cloud teacher:

```powershell
.\.venv\Scripts\python.exe scripts\smoke_demos.py --model cloud
```

Expect ~15–25 s per scenario; cloud is slower than edge for the first
couple of calls because of cold-start.

---

## Step 4 — Deploy (we'll come back to this)

Skipping per your call. When you're ready, see `deploy/README.md` —
two paths:

* **Modal + Vercel** for a fully cloud public URL.
* **ngrok + Vercel** if you want to keep edge inference on your laptop
  but share a public frontend.

Both take ~15 min once steps 1–3 are done.

---

## Sanity table after each step

| After | You should see |
|---|---|
| Step 1 | A folder `y-gemma4-svg-lora/` with `adapter_config.json`, `adapter_model.safetensors`, tokeniser files. |
| Step 2 | Two public HF repos under your handle, both viewable in incognito. |
| Step 2.4 | `ollama list` shows `y-gemma4`. Toolbar shows **Edge fine-tuned** as ready. |
| Step 3 | `/health` returns `cloud.ready=true`. Toolbar shows **Cloud (Gemma 4 31B)** as ready. |
| Step 4 | A `*.vercel.app` URL that loads the canvas and Solves a sample question. |

If any step's verification fails, stop there and ping me — don't push
on to the next step.
