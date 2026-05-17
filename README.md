# Y · the AI that writes on your whiteboard

> Most AI tutors are chat boxes. Most kids don't learn from chat boxes.
> They learn at a whiteboard, with someone who can draw.
> Y is that someone.

A pedagogical AI built around Gemma 4. The student writes a question on a
whiteboard, marks the unknown with `?`, and Y reads the canvas, *teaches by
drawing on the same canvas* in real time, narrating each stroke, and
remembers what the student knows for next time.

Built for the [Gemma 4 Good Hackathon](https://www.kaggle.com/competitions/gemma-4-good-hackathon)
across three tracks:

* **Future of Education** — multi-tool agent, learner-knowledge model,
  educator-coach panel.
* **Ollama** — fully local edge inference on `gemma4:e4b`; the fine-tuned
  variant ships as a `Modelfile`.
* **Unsloth** — QLoRA fine-tune of `gemma-4-E2B-it` on the
  [`ControlSketch-Part`](https://huggingface.co/datasets/seenubhargav/ControlSketch-Part)
  dataset for SVG-stroke generation, exported to GGUF.

| | |
| --- | --- |
| Demo video | _add YouTube link_ |
| Live demo | _add Modal/Vercel link_ |
| Kaggle writeup | _add Kaggle notebook link_ |
| Fine-tuning notebook | [`training/unsloth_train.ipynb`](./training/unsloth_train.ipynb) |
| Dataset on HF | _add HF link_ |
| Adapter on HF | _add HF link_ |

---

## What's new in this build (vs. the v0 chat-box prototype)

1. **SVG-native generation.** A new `draw_part` block primitive lets the
   model emit multi-line SVG paths grouped by part (head, body, ring, etc.)
   inside a single call, instead of a token of tikz or a base64 image. Every
   `<path d="...">` is sanitised by `lxml`, validated against allowed
   elements, and salvaged path-by-path so a single bad stroke never crashes
   the lesson.
2. **Stroke-by-stroke animation locked to TTS.** The frontend
   `LessonPlayer` reveals each path with a transient `stroke-dasharray`
   overlay synchronised to the speech synthesiser's word boundaries. The
   blackboard literally writes itself at the speed of the voice.
3. **Multi-tool agent prompt.** `system.md` now reads as a tool registry:
   `[title]`, `[text]`, `[equation]`, `[draw]`, `[draw_part]`, `[box]`,
   `[node]`, `[arrow]`, `[line]`. Five subject exemplars
   (Pythagoras / free-body / benzene / cell / DFS tree) anchor the model in
   the format.
4. **Teacher Mode** runs a second Gemma call after every lesson and
   surfaces an `EducatorPanel` with misconceptions, follow-ups,
   prerequisites, and a difficulty rating — the "empower the educator"
   half of the Future-of-Education brief.
5. **Latent learner-knowledge model.** `learner.py` extracts concepts from
   each lesson, embeds them with `nomic-embed-text`, and persists a per-user
   profile to disk. The next lesson's system prompt is prepended with a
   1–3-line mastery summary so Y skips topics the student already knows.
   Visualised live in the bottom-left `LearnerPanel` as a rotating 3D UMAP
   point cloud.
6. **Three Gemma 4 backends behind one toolbar.** Edge (`gemma4:e4b`) /
   Edge fine-tuned (`y-gemma4` LoRA-merged GGUF) / Cloud (`gemma-4-31b-it`
   on Google AI Studio). The `/health` endpoint reports per-model
   readiness so the dropdown greys out unconfigured options.
7. **Unsloth QLoRA notebook.** [`training/unsloth_train.ipynb`](./training/unsloth_train.ipynb)
   runs end-to-end on a Kaggle T4: 4-bit `gemma-4-E2B-it`, r=16 LoRA on
   attention + MLP, 2 epochs, GGUF export.

## How it works

```
                                    ┌─────────────────────┐
   student draws on canvas ─PNG───► │  FastAPI /lesson    │
                                    │  ┌──────────────┐   │
                                    │  │ Teacher       │  │
                                    │  │  ├ OllamaTea  │  │
                                    │  │  └ CloudTea   │  │
                                    │  └──────────────┘   │
                                    └─────────┬───────────┘
                                              │ tokens
                              ┌───────────────▼───────────────┐
                              │ IncrementalTagParser          │
                              │  ├ inline tags → primitive    │
                              │  └ draw_part block → svg path │
                              └───────────────┬───────────────┘
                                              │ primitive events
                              ┌───────────────▼───────────────┐
                              │ validate_and_repair (lxml)    │
                              │  ├ schema check + alias map   │
                              │  ├ SVG sanitize (no script,   │
                              │  │  no foreignObject, no js:) │
                              │  ├ per-path salvage           │
                              │  └ fallback to [text] caption │
                              └───────────────┬───────────────┘
                                              │ SSE
                              ┌───────────────▼───────────────┐
                              │ LessonPlayer (Excalidraw)     │
                              │  ├ KaTeX for [equation]       │
                              │  ├ Rough.js for [box/node]    │
                              │  ├ playDrawPart stroke anim   │
                              │  └ Web Speech API word sync   │
                              └───────────────┬───────────────┘
                                              │
   learner.py extract + embed + persist ◄─────┘
              │
              ▼
   data/learners/<id>.json  ──► next lesson's system prompt prefix
```

After the lesson stream, **Teacher Mode** runs a second Gemma call to emit
educator JSON (misconceptions / follow-ups / prereqs / difficulty), and the
**learner module** updates the per-user profile in JSON on disk. The next
`/lesson` request reads that profile and prepends a mastery summary to the
system prompt.

## The primitive vocabulary

The LLM is constrained to a small tag protocol — schema-as-code in
[`schema/primitives.json`](./schema/primitives.json):

| Tag | Purpose | Example |
| --- | --- | --- |
| `title` | Lesson heading | `[title: "Newton's Second Law"]` |
| `text` | Narrated caption (also drawn) | `[text: "Solve for a."]` |
| `equation` | KaTeX-rendered math | `[equation: "a = F / m"]` |
| `box` | Labeled rectangle | `[box: id=A label="Block"]` |
| `node` | Labeled circle | `[node: id=A label="0.6"]` |
| `arrow` | Connect two ids | `[arrow: from=A to=B label="step"]` |
| `line` | Free segment | `[line: x1=0 y1=0 x2=200 y2=0 label="v"]` |
| `draw` | Inline single SVG snippet | `[draw: svg="<path d=...>"]` |
| `draw_part` | **Block** primitive: multi-line SVG paths grouped by part | see `prompts/examples/benzene.md` |

The bet: a tiny structured language is easier to teach a small LLM (and
easier to repair after the fact) than free-form SVG.

## Quick start

Prereqs:

* Python 3.11 / 3.12, Node 20+, [Ollama](https://ollama.com/download), [uv](https://github.com/astral-sh/uv).

```powershell
# 1. .env from template
Copy-Item .env.example .env

# 2. Pull edge models
ollama pull gemma4:e4b
ollama pull nomic-embed-text

# 3. (Optional) Build the fine-tuned tag from the published GGUF
ollama create y-gemma4 -f models/Modelfile.y-gemma4

# 4. Backend
cd api
uv sync
.\.venv\Scripts\python.exe -m uvicorn main:app --port 8000

# 5. Frontend (separate shell)
cd web
npm install --legacy-peer-deps
npm run dev
```

Open <http://localhost:3000>. Pick a sample subject (Math / Physics / Chem
/ Bio / CS) or write your own question with the pen tool, mark the
unknown with `?`, then **Solve**.

For deployment topologies (local-only, Modal+Vercel cloud-only, hybrid)
see [`deploy/README.md`](./deploy/README.md).

## Reproducibility

Everything in this repo is reproducible from a clean checkout:

* **Schema** — single source of truth at [`schema/primitives.json`](./schema/primitives.json),
  consumed by both backend (validator) and frontend (renderer).
* **Prompts** — versioned under [`api/prompts/`](./api/prompts), including
  the five subject exemplars used for in-context calibration.
* **Dataset** — [`training/prepare_dataset.py`](./training/prepare_dataset.py)
  converts ControlSketch-Part into the part-structured instruction JSONL we
  fine-tune on. Run with `--push <hf-repo>` to mirror to Hugging Face.
* **Fine-tune** — [`training/unsloth_train.ipynb`](./training/unsloth_train.ipynb)
  runs on a Kaggle T4 in ≈2 hours; outputs a LoRA, optional GGUF, optional
  HF push.
* **Inference** — [`models/Modelfile.y-gemma4`](./models/Modelfile.y-gemma4)
  wraps the GGUF with the same system prompt the API uses, so behaviour
  matches between training and serving.
* **Tests** — `api/scripts/test_parser.py` and `api/scripts/test_teacher.py`
  cover the parser/validator and educator-JSON repair paths in ~1 second
  with no network access.

## Smoke tests

```powershell
# Unit tests (no network required)
cd api
.\.venv\Scripts\python.exe scripts\test_parser.py
.\.venv\Scripts\python.exe scripts\test_teacher.py

# 5 subjects × 3 model variants matrix (requires running API)
.\.venv\Scripts\python.exe scripts\smoke_demos.py --all-models
```

## Repository layout

```
Y/
├── web/                      Next.js 16 / React 19 / Excalidraw / KaTeX
│   └── src/
│       ├── app/              page.tsx · main orchestrator
│       ├── components/       Whiteboard, Toolbar, EducatorPanel, LearnerPanel
│       └── lib/              api, renderer, lesson-player, rough-svg, layout, types
├── api/                      FastAPI + Ollama + Cloud teacher
│   ├── main.py               /health · /schema · /lesson · /learner
│   ├── teacher.py            Teacher protocol + OllamaTeacher + CloudTeacher
│   ├── parser.py             incremental tag state machine (block-aware)
│   ├── validator.py          schema check, SVG sanitize, path salvage
│   ├── learner.py            concept extraction + embedding + JSON store
│   ├── prompts/              system.md + primitives.md + 5 examples/
│   └── scripts/              parser tests, teacher tests, demo smoke
├── schema/primitives.json    single source of truth for the tag protocol
├── training/
│   ├── prepare_dataset.py    ControlSketch-Part → instruction JSONL
│   ├── _build_notebook.py    generator for the Kaggle notebook
│   └── unsloth_train.ipynb   QLoRA on gemma-4-E2B-it
├── models/
│   ├── Modelfile.y-gemma4    Ollama wrapper for the fine-tuned GGUF
│   └── README.md             how to build the local tag
├── deploy/
│   ├── modal_app.py          serverless API on Modal
│   └── README.md             local / cloud / hybrid topologies
├── docs/video_script.md      shooting script for the YouTube demo
└── .env.example
```

## Ethics & limitations

* **Privacy.** Learner profiles are JSON files on disk, never sent
  anywhere by default. The cloud teacher path is opt-in and only fires
  when the toolbar is set to "Cloud."
* **Hallucinations.** The model is small. Wrong answers are possible.
  Teacher Mode's misconception list partially mitigates this by
  surfacing common errors next to the lesson; the educator can verify.
* **Accessibility.** TTS uses the browser's Web Speech API; we lean on
  the OS voice for now. Captions are drawn on the canvas as text so the
  lesson is fully readable with sound off.
* **Languages.** English only at the moment. The primitive grammar is
  language-independent; only the prompts and exemplars need translation.

## License

MIT. See [`LICENSE`](./LICENSE).

## Acknowledgements

* The Gemma 4 team at Google for the model that runs this entire show.
* The Ollama and Unsloth maintainers for making local + cheap fine-tunes
  realistic on a single 8 GB consumer GPU.
* The Excalidraw team for an open whiteboard you can actually build on.
* The ControlSketch authors for releasing a part-structured sketch
  dataset that turned out to be the perfect fuel for SVG-as-language.
