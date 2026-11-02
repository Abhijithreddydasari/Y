# H5 brief: session-wise learner model and visible adaptation

Status: built 2026-11-02 (confirmed by the user; see [handoff](../handoffs/H5.md)). Branch `feature/learner-model`, cut from
`main` at `5287d6b` (H4 merged). Roadmap: [H5](ROADMAP.md). Depends on [H1](../handoffs/H1.md),
[H3](../handoffs/H3.md) and [H4](../handoffs/H4.md).

## Learner story

Session 1: I learn attention and softmax and answer a few checks (one wrong, showing a
misconception). I press **End session**. Session 2: I ask about multi-head attention. The first turn
starts from what I showed: it builds on what I knew, re-checks the shaky part and shows a
`because` chip ("you mixed up X last time"). With **Memory off**, the same question gets the
generic opening.

## Step 1: OpenAI Decisions API as the evidence labeler

Real API, from OpenAI's docs ([guide](https://developers.openai.com/api/docs/guides/decisions),
[reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)):
- `POST https://api.openai.com/v1/decisions`, `Authorization: Bearer $OPENAI_API_KEY`.
- The model is `gpt-6-luna`; the docs say it is the only supported model.
- The body is `{model, input, questions}`.
  - `input` holds messages whose parts are `input_text`, `input_image` (data URL or https, with
    `detail`) or `input_json`.
  - `questions` holds 1–400 typed questions. `choice` takes 2–255 `{value, description}` choices.
- The response is `{model, answers[], usage}`, with answers in question order. A choice answer has
  `choice`, `probabilities: [{value, probability}]` and `confidence`. A `refusal` answer can appear
  for a single question.
- Error codes and rate limits are not documented, so the HTTP status is mapped exactly as H4 does.

Wiring:
- `decisions.py` gets an `EvidenceLabelProvider` protocol with `configured`, `timeout`, `model`,
  `provider_name` and `label(state, asked, images=())`. Both clients return the same
  `EvidenceResponse` (a dict keyed by question name).
  - `BasetenEvidenceLabeler`: the existing Elephant client, renamed, with an alias kept.
    Text only, so images are ignored.
  - `OpenAIEvidenceLabeler`: builds the request and parses the answer list back to a dict by
    `name`.
    - A `refusal` answer leaves that field untaken, and the rest still count.
    - It keeps the same caps, status mapping, 128 KiB response limit and strict JSON parsing.
- Learner content goes in `input` as an `input_json` part holding the state, plus the ink crop
  images. Each question's instructions carry the "untrusted learner input" rule.
- Env settings. Only `OPENAI_API_KEY` is a secret, and it goes in root `.env`. The other three
  are optional and documented in `.env.example`:
  - `EVIDENCE_LABEL_PROVIDER=openai|baseten` (default `baseten`, so nothing changes until it is set);
  - `EVIDENCE_LABEL_MODEL` (default `gpt-6-luna` for openai, Elephant for baseten);
  - `OPENAI_BASE_URL` (default `https://api.openai.com/v1`).
  - Selection is explicit, with no fallback provider, and an unknown value is a startup error.
  - The existing `DECISION_PROVIDER` still drives the older capture assessor, unchanged.
- `labeler`, the provenance on `Observation`, widens to `"deterministic" | "baseten" | "openai" | "none"`.
  This is a contract change, recorded in the handoff with the TypeScript mirror.

Images (bounded):
- Only for `via=ink` answers. H4 already proves every `element_id` is `creator=human`.
- A crop is attached only when its `element_ids` are a non-empty subset of the answer's
  `element_ids`. It must also be an asset stored on this session's board.
- At most 2 crops, as the existing ≤ 2 crops cap requires. Their hashes are stored with the
  row, so a re-label at close reuses them.
- Tutor-drawn content is never sent as evidence. The question, options and key go as labeled
  tutor context, as in H4.
- Deterministic verifiers still run first. Budget (60 per owner, 300 globally per hour),
  concurrency 2, an 8 s timeout plus a guard, and no retry are unchanged.

Tests (mocked transport): the request shape (model, input parts, choice lists, no tutor image),
Bearer auth, 401/403/429/500/timeout/malformed/refusal/wrong option, image parts present only for
learner crops, provider selection from the environment, and a missing key.
Live: `scripts/live_evidence.py --provider openai`, 12 cases, latency per call. It runs once
`OPENAI_API_KEY` is in `.env`. Until then, mocked labels.

## Step 2: seal, reduce, consolidate, brief

**Close.** `POST /learning/sessions/{sid}/close` (owner only, proxied):
1. It sets the session to `closing`, so new turns get 409.
2. It re-labels rows that are `pending`, or `failed` with no observation and a retryable code.
   Each re-label goes through `observations.label` with the same budget and a 20 s total wait.
   Whatever is still unlabeled is left out and listed.
3. The reducer and the consolidator run, and the revision is written.
4. The session becomes `closed`.
- **Idempotent**: a `learning_profile_revisions` row is unique on `session_id`. A replayed close
  returns the stored revision with `replayed: true`, and nothing is counted twice. The same holds
  under a concurrent double click (unique constraint, insert-or-get).

**Reducer** (`api/learning/profile.py`, pure and deterministic):
- It starts from the owner's latest revision, with a Beta(1, 1) prior per concept × dimension.
- Each observation adds `w = format_weight × key_factor × assistance_factor` to alpha or beta:
  correct → alpha += w; partial → alpha += w/2 and beta += w/2; incorrect or unanswered → beta += w.
  - `key_factor`: `wrong` → skipped, `suspect` → 0.5, `ok` → 1.
  - `assistance_factor`: a reveal is already in `format_weight`; a hint is 0.7.
  - Low `label_confidence` scales `w` by that confidence.
- Recall half-life:
  - It starts at 24 h for a concept's first evidence.
  - A correct recall-or-understand answer that comes ≥ 50 % of a half-life after the last
    evidence doubles it; an incorrect one halves it (floor 4 h).
  - Before new evidence is added, beliefs decay toward the prior as `2^(−Δt/half_life)`.
- Misconception ledger: a misconception id seen in this session is `active` with its evidence.
  A previously active one is `resolved` after two later correct answers on that concept with no
  recurrence.

**Teaching notes**:
- Model and request: Muse Spark Open on Baseten (`meta-models/muse-spark-open-1026`) with strict
  `json_schema` `{notes: [{text, cites: [observation_id]}]}`. The input is the observation list
  (ids, concept, outcome, misconception, miss class, modality and the learner answer text,
  truncated) and the reducer summary.
- Notes citing ids outside this session's observations are dropped, and so are uncited notes.
  At most 6 notes.
- Bounds: one call per close, `max_tokens` 3000 for reasoning room, 30 s timeout, one retry on
  empty content, and the per-owner tutor budget.
- On failure the revision is still written with `notes=[]`, and the error is shown in the close
  response and trace.

**Brief** (`compile_brief(profile, topic)`, deterministic, no model call):
- It is built at the first turn of a session from the owner's latest revision.
- Items, each citing evidence ids:
  - K: known, where the mean is ≥ 0.7 with ≥ 1 evidence;
  - S: shaky, with a mean of 0.35–0.7 or recall due by half-life;
  - M: active misconceptions;
  - N: notes.
- Concepts matching the question's words rank first, then by recency.
- It is capped by `LearnerBrief` (≤ 24 items, ≤ 2400 characters ≈ 600 tokens) and stored on the
  session, so later turns in that session reuse the same brief.
- `build_messages(brief_text, …)` gets the rendered items, and `TurnValidator(brief.refs, …)` gets
  the refs.
- `because` is re-enabled in `ENABLED` only when the brief has items. The board shows it as a
  small chip next to its segment. The prompt says when to use it (at most one per turn, only
  for real brief ids).

**Memory toggle**:
- `memory` (on/off) is stored per session and set from the composer before the first turn. A
  toggle mid-session applies from the next turn.
- Off: an empty brief, `because` disabled, and evidence still captured.
- **Profile writes are unchanged by the toggle**: a session with Memory off still seals at close,
  so the comparison is only about reading.

**`profile_updated`**:
- The evidence route and the close response report `true` exactly when a revision row exists for
  that session.
- A new `GET /learning/profile` returns the latest revision summary and brief preview, for the
  trace and for H6.

**Web**:
- An **End session** button in the toolbar calls close and shows a small summary toast ("3
  answers sealed, 1 misconception noted"). It then starts a fresh board session, a new
  localStorage id, and keeps the old board saved.
- A **Memory** switch in the composer.
- A `because` chip in the renderer, a small non-interactive label. It never covers learner ink.

## Acceptance

- Replaying close twice, or two concurrent closes, gives one revision with the same counts.
- `wrong` keys are skipped and `suspect` ones are halved (unit tests).
- Session 2's first turn has a brief with ≥ 1 item citing session-1 evidence, and a `because` chip
  whose refs exist. With Memory off, the same question gives a turn with no brief and no
  `because`, which is visibly generic.
- An uncited or foreign-cited note is dropped.
- `profile_updated` is true only after a real revision.
- Live checks, labeled live vs mocked with latency:
  - the OpenAI labeler, 12 cases;
  - Spark Open notes, 2–3 closes;
  - the session-2 first turn with memory on and off, same question, 2 pairs.
- Full backend and frontend suites, tsc, lint, build, and a browser journey (session 1 → End
  session → session 2 with memory on, then off).

## Exclusions

Constellation (H6), warm-up cards (H7), the trace drawer UI (H8), and a card control for "answer
in ink" (H7/H8; ink answers are server-tested with crops), and no per-turn profile writes.

## Files

`api/learning/decisions.py`, `observations.py`, new `profile.py` and `consolidate.py`,
`storage.py` (the revisions table and session `memory`/`brief_json` columns), `tutor_router.py`,
`tutor_turn.py` (`ENABLED`), `learner_contracts.py` (labeler literal), `api/prompts/tutor-v1.md`
(the `because` rule), `api/scripts/live_evidence.py`, a new `api/scripts/live_memory.py`,
`.env.example`, the web proxy route, toolbar, composer, renderer chip, contract mirror, tests and
docs.
