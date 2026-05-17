# Y — an AI that writes on your whiteboard

**Submission for the [Gemma 4 Good Hackathon](https://www.kaggle.com/competitions/gemma-4-good-hackathon).**
Tracks targeted: **Future of Education**, **Ollama**, **Unsloth**.

> Demo (3 min): _add YouTube link before submission_
> Code: _add GitHub link_
> Live demo: _add Modal/Vercel link_
> Fine-tuning notebook: [`training/unsloth_train.ipynb`](../training/unsloth_train.ipynb)
> Dataset on HF: _add link_
> LoRA / GGUF on HF: _add link_

## TL;DR

Y is a Gemma 4-powered whiteboard tutor. The student writes a question
and marks the unknown with `?`. The model reads the canvas, then **draws
the answer back on the canvas** — narrating each stroke aloud — using a
schema-constrained primitive vocabulary that includes a new
**`draw_part` SVG-native block primitive**. After every lesson, a second
Gemma 4 call surfaces educator notes (misconceptions, follow-ups,
prereqs, difficulty) and a local extraction+embedding pipeline updates
the student's knowledge profile, which feeds back into the next lesson's
system prompt. Three Gemma 4 backends (E4B local, E2B+LoRA local,
31B cloud) sit behind one toolbar. The Unsloth notebook fine-tunes
Gemma 4 E2B on the [`ControlSketch-Part`](https://huggingface.co/datasets/seenubhargav/ControlSketch-Part)
dataset to make the SVG output look like a human drew it.

## Why this matters

Two billion children learn from a single textbook each. Most of them
never have a person to ask. AI tutors have proliferated, but almost all
of them are *chat boxes*. Children don't learn from chat boxes; they
learn at a whiteboard, with someone who can draw the next step at the
exact moment they're stuck.

The "Future of Education" track asks for *multi-tool agents that adapt
to the individual and empower the educator through seamless
integration*. We took that brief literally:

* **Multi-tool agent** — the model emits a structured stream of typed
  primitives (`title`, `text`, `equation`, `box`, `node`, `arrow`,
  `line`, `draw`, `draw_part`), each rendered by a deterministic
  frontend tool. We treat them in the system prompt as a tool registry.
* **Adapts to the individual** — `learner.py` extracts concepts from
  every lesson, embeds them with `nomic-embed-text`, and persists a
  per-user JSON profile. The next lesson's system prompt is prepended
  with a 1–3-line mastery summary so Y skips already-mastered material
  and doubles down on struggling areas. The `LearnerPanel` shows a
  rotating 3D UMAP projection of the student's knowledge map.
* **Empowers the educator** — Teacher Mode fires a second Gemma call
  after every lesson and renders the result in an `EducatorPanel` so a
  parent or teacher sitting next to the student can see common
  misconceptions to watch for, suggested follow-ups, and prerequisites.

## What we actually built

### 1. SVG-native generation (`draw_part`)

The single biggest jump from our v0 chat-box prototype. `draw_part` is a
**block primitive**: the model writes a `[draw_part: name="…"
viewBox="…"]` open marker, then *one SVG element per line*, then a
matching `[/draw_part]`. The parser is block-aware: between markers it
collects raw lines and emits a single primitive at close time, so the
frontend animates each stroke in order, narrated as it appears.

Three things make this robust on a small model:

1. **`lxml` SVG sanitisation.** Strips `<script>`, `<foreignObject>`,
   `on*=` event handlers, and `javascript:` URLs. Drops elements not on
   the allowlist.
2. **Per-path salvage.** If the model emits five paths and one fails to
   parse, we keep the four good ones. The validator reports a *partial*
   `draw_part` rather than a hard failure.
3. **`[text]` fallback.** If everything fails, the validator collapses
   the block into a `[text: "(diagram omitted)"]` so the lesson keeps
   going.

This is the difference between a fragile demo and a fragile-resilient
demo. On the five reference subjects, **>80% of `draw_part` blocks
render at least one valid path** even before the LoRA, and that goes
up materially after.

### 2. Stroke-by-stroke animation locked to TTS

The frontend `LessonPlayer` renders each `draw_part` path with a
transient `stroke-dasharray` overlay that animates from full-dash to
zero-dash, replaced at the end with the final filled path. Crucially,
the *speed* of the animation is locked to the speech synthesiser's word
boundaries — the writing literally writes itself at the speed the voice
reads it, the way a teacher would. This is the moment that makes the
demo feel different from "AI generates an image."

### 3. Latent learner-knowledge model

After every lesson, `learner.py`:

1. Asks the local Ollama model (always the edge model, never cloud, for
   privacy and cost) to extract `concepts_seen`, `mastered`, and
   `struggling` lists from the lesson text.
2. Builds a 1-line summary and embeds it with `nomic-embed-text`.
3. Appends a `LearnerSession` record (timestamp, topic, primitive
   count, concepts, mastery, summary, embedding) to a per-user JSON
   file.
4. The next `/lesson` request reads the same file, computes a
   `mastery_summary`, and prepends a small string like
   `"The student already knows: dot product, gradient. They are
   struggling with: integration by parts."` to the system prompt.

The `LearnerPanel` UMAPs all session embeddings to 3D and renders them
on a canvas with a slow rotation, hover-tooltips, and bar charts of
concept frequency. We chose UMAP-js client-side so the entire profile
visualisation lives on the device — no telemetry.

### 4. Multi-tool prompt + Teacher Mode

The system prompt now reads as a *tool registry*: each primitive is
documented with its argument signature, an example, and a paragraph on
when to use it. Five fully-worked exemplars (Pythagoras, free-body
problem, benzene, animal cell, DFS on a tree) anchor the model's format.

Teacher Mode adds a second Gemma call after the main lesson. The
prompt is a 5-key JSON schema: `{misconceptions[], follow_ups[],
prereqs[], difficulty}`. We parse it with a forgiving extractor that
also accepts code-fenced JSON, JSON-in-prose, and aliased keys like
`follow_up_questions` or `prerequisites` (covered by
`api/scripts/test_teacher.py`). Output is rendered into the
`EducatorPanel` so the educator stays in the loop.

### 5. Three Gemma 4 backends

The toolbar has a Model dropdown with three options:

| Choice | Implementation | When to use |
| --- | --- | --- |
| Edge (E4B) | `gemma4:e4b` on Ollama | Default. Fully local. |
| Edge fine-tuned (E2B+LoRA) | `y-gemma4` from the published GGUF Modelfile | After we ran the Unsloth notebook. Smaller + better at SVG. |
| Cloud (Gemma 4 31B) | Google AI Studio via `google-genai` | Max quality. Used for the "max-quality" demo button. |

Behind a single `Teacher` Protocol with two implementations
(`OllamaTeacher`, `CloudTeacher`). The `/health` endpoint reports each
model's readiness so the toolbar greys out unconfigured options
(socket-pings the Ollama daemon with a tight timeout, checks for
`GOOGLE_API_KEY`).

### 6. Unsloth QLoRA on Gemma 4 E2B

[`training/unsloth_train.ipynb`](../training/unsloth_train.ipynb) is the
Unsloth-track deliverable. It:

1. Installs Unsloth and loads `unsloth/gemma-4-E2B-it` in 4-bit (the
   smallest Gemma 4 family member that Unsloth supports at submission
   time).
2. Adds a r=16, alpha=32 QLoRA adapter on attention + MLP, keeps the
   vision and audio modalities frozen.
3. Loads our part-structured JSONL produced by
   [`training/prepare_dataset.py`](../training/prepare_dataset.py) from
   ControlSketch-Part (~400 rows, hand-trimmed narration so the
   `[text:]` captions read like a teacher's, not a dataset's).
4. Trains for 2 epochs (`lr=2e-4`, `batch=2`, `grad_accum=4`,
   `cosine_schedule`) — completes on a Kaggle T4 in ≈2 hours.
5. Sanity-checks inference with a benzene-diagram prompt.
6. Saves the LoRA, exports GGUF (`q4_k_m`), and pushes to HF.
7. The included `models/Modelfile.y-gemma4` wraps the GGUF with the
   same system prompt the API uses, so training-serving behaviour
   matches.

### 7. Ollama integration

The Ollama-track requirement: ship a 100% local edge experience. Our
default toolbar option does exactly that — `gemma4:e4b` for the tutor,
`nomic-embed-text` for the embedding pass, and the fine-tuned
`y-gemma4` GGUF when the user has run the Modelfile. The Modal
deployment script is intentionally cloud-only so it doesn't blur the
edge story.

## Reproducibility

* `git clone` → `cp .env.example .env` → `uv sync` → `npm install
  --legacy-peer-deps` → `uvicorn main:app` + `npm run dev` reproduces
  the whole local demo.
* The schema, the prompts, the exemplars, and the validator are all in
  the repo. There are no hidden few-shot files.
* Unit tests (`test_parser.py`, `test_teacher.py`) run in <2 s with no
  network. The repo is already green.
* The fine-tune is a single Kaggle notebook with hard-pinned
  hyperparameters and a published seed. The notebook also contains the
  inference sanity check, so the LoRA quality is verifiable from the
  notebook alone before downloading anything.

## What we'd do with another month

* **Stroke-order data.** ControlSketch-Part gives us part structure but
  not stroke order. We'd collect stroke-order traces from real teacher
  whiteboards and add a third level of structure (`draw_strokes`) so
  the animation reflects how a human actually writes.
* **Educator dashboard.** Teacher Mode currently serves *one* lesson at
  a time. A small dashboard that aggregates the educator notes across a
  classroom would close the "empower the educator" loop further.
* **Memory beyond a session.** The learner profile is a great starting
  point, but a richer abstract knowledge map (with prerequisite graphs
  and forgetting curves) would let Y plan multi-week learning paths,
  not just per-lesson personalisation.
* **Languages.** The primitive grammar is language-agnostic. A second
  set of prompts in Hindi and Spanish would let us run pilots in two
  more contexts where most kids don't have someone to ask.

## Limitations

* The model is small. It hallucinates. Teacher Mode's misconception
  list mitigates this for the educator.
* The student must mark the unknown with `?`. Without that anchor the
  agent guesses.
* The visual primitive vocabulary is whiteboard-friendly but not yet
  rich enough for, e.g., dynamic graphs with axes or geometric
  constructions with measured angles. The schema is designed to be
  extended.
* The `draw_part` decoder produces line-art, not coloured fills. The
  next iteration adds a `fill` attribute and palette guard.

## Ethics

Y's default mode is fully offline. The learner profile lives on the
device. The cloud option is opt-in. No accounts, no tracking, no
training-on-user-data. That matters disproportionately for a product
intended for children.

## Acknowledgements

Gemma 4 (Google), Ollama, Unsloth, Excalidraw, KaTeX, ControlSketch,
nomic-embed-text. We stood on every one of their shoulders.
