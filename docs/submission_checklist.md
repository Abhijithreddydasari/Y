# Submission checklist

Run this top-to-bottom an hour before the deadline. Each item is binary;
no "mostly done" allowed. Cross off as you go.

## 0. Final code state

* [ ] `git status` clean on the submission branch.
* [ ] `cd web && npx tsc --noEmit` → 0 errors.
* [ ] `cd web && next build` → succeeds.
* [ ] `cd api && .\.venv\Scripts\python.exe scripts\test_parser.py` → PASS.
* [ ] `cd api && .\.venv\Scripts\python.exe scripts\test_teacher.py` → PASS.
* [ ] `cd api && .\.venv\Scripts\python.exe scripts\smoke_demos.py --model edge` → 5/5 (with Ollama up).
* [ ] If you have time: `--all-models` matrix prints with no FAIL cells.

## 1. Hugging Face artefacts

* [ ] Dataset uploaded:
  `huggingface.co/datasets/<user>/y-svg-lessons` is public and contains
  `svg_lessons.jsonl`.
* [ ] LoRA uploaded:
  `huggingface.co/<user>/y-gemma3n-svg-lora` is public and contains the
  adapter shards + tokeniser.
* [ ] (Optional) GGUF uploaded:
  `huggingface.co/<user>/y-gemma3n-svg-gguf` with `q4_k_m`.
* [ ] All three repos linked from the README and the writeup.

## 2. Ollama

* [ ] `ollama create y-gemma4 -f models/Modelfile.y-gemma4` succeeds.
* [ ] Toolbar dropdown's "Edge fine-tuned" lights up green.
* [ ] One smoke lesson runs end-to-end on the fine-tuned tag.

## 3. Cloud teacher (optional but unlocks the third track)

* [ ] `GOOGLE_API_KEY` set in `.env` (or in `modal secret`).
* [ ] `cd api && uv pip install -e ".[cloud]"` (or `google-genai` already
  installed).
* [ ] Toolbar dropdown's "Cloud (Gemma 4 31B)" lights up green.
* [ ] One smoke lesson on the cloud teacher.

## 4. Deploy (live demo URL)

Pick **one** path and link it from the writeup:

### 4a. Modal + Vercel
* [ ] `modal deploy deploy/modal_app.py` returns a `*.modal.run` URL.
* [ ] `vercel --prod` returns a Vercel URL.
* [ ] Open the Vercel URL → Solve a sample → see strokes draw.

### 4b. ngrok + local
* [ ] `ngrok http 8000` returns a public URL.
* [ ] Set `NEXT_PUBLIC_API_BASE` on Vercel and redeploy.

## 5. Video

* [ ] Recorded ≤ 3:00.
* [ ] All three demos visible.
* [ ] Audio clean (no laptop fan).
* [ ] Uploaded as **public** to YouTube.
* [ ] First line of description has the GitHub link.
* [ ] Pinned comment with the live demo link + Kaggle writeup link.

## 6. GitHub

* [ ] Repo is public.
* [ ] README has a working demo video embed.
* [ ] README has the live demo link.
* [ ] LICENSE file present (MIT).
* [ ] `.env.example` is committed; `.env` is NOT committed.
* [ ] No GGUF binaries committed (gitignored).
* [ ] No HF tokens committed.
* [ ] Tag the submission commit: `git tag gemma-4-good-hackathon-submission`.

## 7. Kaggle writeup

* [ ] `docs/kaggle_writeup.md` rendered as a Kaggle Notebook (markdown
      only, no code cells).
* [ ] All four submission links filled in (YouTube · GitHub · Live demo
      · HF).
* [ ] Three tracks explicitly named.
* [ ] Architecture diagram from `docs/architecture.md` embedded as an
      image (mermaid renders aren't supported on Kaggle — export to
      PNG).
* [ ] Submit via the Kaggle competition UI before the deadline.

## 8. Last-minute sanity

* [ ] Open the live demo from a different machine (or your phone) — no
      `localhost` references work.
* [ ] Toggle Teacher Mode → see the educator panel fill in.
* [ ] Run a second lesson on a different subject → see the
      LearnerPanel UMAP grow.
* [ ] Refresh the page → state persists (the user_id is per-browser).
* [ ] Hit Stop mid-lesson → no console errors.
