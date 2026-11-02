# H4 — Evidence capture

Status: confirmed and built, 2026-11-02 (as built: [handoff](../handoffs/H4.md)). Branch `feature/evidence-capture` from `main` at
`254cbca` (H3 merged). Priority P0. Depends on H0 contracts and H1's answer path.

## Learner story

The learner answers a predict or check card by tapping an option, typing, or speaking. The
feedback turn starts exactly as fast as today. Behind it, Y records the answer once as learner
evidence: a deterministic grade where one exists, then a label from the Baseten decision model
(Elephant) for outcome, misconception and miss class. The learner never sees labeling. A
developer sees each observation and any labeling failure in the evidence trace. H5 reduces these
observations at session close; H4 writes no profile.

## Acceptance scenarios

1. Tap the right mcq option → one observation, `outcome=correct`, `labeler=deterministic`, no
   paid call.
2. Tap a wrong option → `incorrect` at once; Elephant later adds a miss class and picks the
   misconception from that check's candidates. Turn latency is unchanged (mocked test asserts the
   turn never awaits the labeler).
3. Type `25/3` when the key is `8.333` → numeric verifier says correct. Type `2(x+1)` for key
   `2x+2` → symbolic verifier says correct.
4. The key is wrong: the check asks for `\sqrt{64}` with key `6`. The key audit recomputes 8 and
   marks the key `wrong`. The learner who typed 8 is not marked incorrect, and the feedback turn
   is told the key is suspect.
5. Speak "B" → observation with modality `spoken` and the lower spoken format weight.
6. Submit the same answer twice (double-click, retry after a failed feedback turn, replayed turn
   id) → exactly one observation for `(session_id, qid)`.
7. Baseten returns 403, times out or is unconfigured → the row shows `failed` with a safe code in
   the trace; the lesson continues and the learner sees nothing.
8. "Just tell me" → `outcome=unanswered`, `assistance.solution_revealed=true`, no paid call.

## Design

### Capture point (tutor turn and answer path)

- In `tutor_router.turn`, only when `store.begin` claims a new answer turn (never on replay),
  `grade()` runs as now, then `observations.capture()` writes one evidence row in a short
  transaction. The row is written before the provider stream starts, so the answer is recorded even
  if the feedback turn fails.
- Labeling is scheduled with `asyncio.create_task`, the same pattern as `image_jobs.start`. The SSE
  generator never awaits it.
- Tutor-authored content is never a source. The question, options and key are stored as
  context for the labeler but never in `sources`. Observations come only from `kind=answer`
  turns. Each source is the learner's input: `event_id` = the answer `turn_id`,
  `content_hash` = SHA-256 of the exact answer text, `modality`, `author=learner`. Ink element ids
  must be `creator=human` in the saved board, or capture rejects them.
- `TurnInput` gains `via: tap | typed | spoken | ink` (default: `tap` for a choice, `typed` for
  text). The card sends `spoken` when the mic produced the answer. It is stored in the row only; the
  tutor prompt is unchanged.

### Deterministic verifiers first (`observations.py`)

- **Option key**: a predict or mcq is `correct` or `incorrect` by exact option match, with label
  confidence 1.0.
- **Numeric**: decimals, signs, `a/b`, `\frac{a}{b}`, percent and scientific notation, an
  optional `x =` prefix, and LaTeX `\times` and `\cdot`. The tolerance follows the key's precision:
  a key of `22.6` accepts 22.6 ± 0.05.
- **Symbolic**: a small recursive-descent parser for numbers, single-letter variables, `+ - * / ^`,
  implicit products, parentheses and `sqrt sin cos tan exp log ln`. It builds closures and never
  calls `eval`. Two expressions are equal if they agree at 8 seeded random points within a relative
  tolerance. Text it cannot parse is `None` (not verifiable), never wrong.
- **Key audit**: when the question has exactly one closed numeric expression (no variables) that
  the parser can evaluate, it is compared with a numeric key. A mismatch marks `key_status=wrong`.
  A free check whose key does not parse as an answer to its own expression is left alone. Elephant
  adds a second opinion later (`key_valid`, below), which can only raise `suspect`.
  - With `key_status=wrong`, grading uses the recomputed value, and `this_turn` carries
    `key_audit: {recomputed}`. The feedback turn then does not contradict a correct learner. This is
    the only tutor-turn change, and it is synchronous and takes microseconds.
- **Grade mapping**: a verifier result of `None` leaves the free answer `unverified` for the
  tutor, as today, and for Elephant.

### Elephant labeling (`decisions.py` additions)

Elephant is a typed decision model: it returns a probability per option for each choice question
and does not generate text. One System One request per observation, with only the questions that
are still open:

| Question | Options | When |
|---|---|---|
| `outcome` | correct, partial, incorrect, unanswered | no deterministic grade |
| `miss_class` | none, cue, discrimination, execution, careless, structural | outcome not correct |
| `misconception` | `none`, `other`, plus up to 6 candidates | outcome not correct |
| `key_valid` | valid, invalid, unsure | always (cheap, same prefill) |

- **Misconception candidates**: the wrong options of that check ("believes ⟨option⟩"), plus
  misconception ids already in this session's observations for the same concept. The id is
  `<concept>/<option-slug>`, which matches `Identifier`. `other` and `none` map to `null`.
- **State sent**: question, options, key, learner answer and modality. Instructions treat the
  answer as untrusted evidence, as in the existing capture prompts.
- **Acceptance**: a field is taken only when its top probability is ≥ 0.5, otherwise it is `null`.
  An `outcome` below 0.5 leaves the observation unlabeled. `label_confidence` is the minimum
  top probability over the fields the model set.
- **Labeler value**: `labeler=baseten` when the model set any field, otherwise `deterministic`.
  Per-field provenance and the raw distribution stay in the row.
- **Calls are bounded**:
  - 2 concurrent calls per process (semaphore);
  - an 8 s timeout and no automatic retry;
  - budget in the shared `learning_budgets` table, charged before the call: 60 per owner and 300
    globally per hour;
  - a missing key fails as `labeler_not_configured` with no charge;
  - a lease on the row so two processes never label the same observation.
- **Failure codes** reuse `ProviderFailure` (`provider_timeout`, `provider_http_error`, …), plus
  `provider_auth_failed` for 401/403. They are stored on the row and logged by code only, never
  with answer text or keys.

### Storage (`storage.py` additions)

- New table `learning_observations`:
  - `observation_id`, `session_id`, `owner_id`, `qid`, `turn_id`, `status`, `modality`;
  - `question_json` (with the key, server-only), `answer_text`, `verifier_json`, `label_json`
    (raw distributions plus field provenance), `observation_json` (the H0 contract);
  - `key_status`, `error`, `duplicates`, `label_ms`, `lease_until`, `created_at`.
- **Dedupe**: `UNIQUE(session_id, qid)`. `capture()` is insert-or-get: a duplicate increments
  `duplicates`, schedules nothing and never changes the first answer.
- `status` moves `pending → labeled | deterministic | failed | skipped`.
- Created with `checkfirst` like the H1 table, and Postgres-safe.

### Trace and profile

- `GET /learning/sessions/{sid}/evidence` (owner only, proxied) lists rows:
  - `qid`, `status`, `outcome`, `misconception`, `miss_class`, `modality`, `format_weight`;
  - `key_status`, `labeler`, `error`, `label_ms`, `duplicates`;
  - `profile_updated: false`.

  H8's trace drawer reads this route; H4 adds no learner-visible UI.
- No profile tables are written. `Assessment.profile_updated` stays `Literal[False]`.

### Contract change (H0 surface, noted in the handoff)

`Observation` gains two fields with defaults, so the fixture still validates:
- `format_weight: Probability = 1.0`:
  - tap mcq: `1 − 1/n` (guessing), predict 0.5;
  - typed free 1.0, spoken 0.9, ink 0.9;
  - × 0.5 if the solution was revealed.
- `key_status: "ok" | "suspect" | "wrong" = "ok"`. H5 skips `wrong` and down-weights `suspect`.

The TypeScript mirror is updated to match. A predict has no `concept` or `dim` in the move schema.
H4 uses the concept of the latest check in the session (else a slug of the turn's first segment
goal) with `dimension=understand`. The checked-in move schema does not change.

## Scope and exclusions

- **Owned**: `api/learning/observations.py` (new), `decisions.py` and `storage.py` additions, the
  capture and audit hooks in `tutor_router.py` and `tutor_turn.py`, `via` in the card/hook answer
  path, the learner-contracts mirror, the evidence route and the proxy allowlist entry.
- **Excluded**:
  - profile reduction, briefs and session close (H5);
  - the trace drawer UI (H8);
  - widget interactions as evidence;
  - re-labeling failed rows (H5 may retry at close within the same budget).
- **Ink**: the server accepts `via=ink` with human-only element ids and validates their
  provenance. There is no "answer in ink" card control yet (the tutor path has no ink reader for
  answers); that UI is deferred to H7/H8 unless you want it here.

## Tests (mocked)

- **Verifiers**: options, numeric forms and tolerance, symbolic equal and unequal, unparseable →
  `None`, a parser that rejects names and depth, key audit catching `\sqrt{64}`→6 and `7 \times 8`→54.
- **Dedupe**: double submit, replayed turn id, re-answer after a failed feedback turn, concurrent
  inserts.
- **Provenance**:
  - sources hold only the learner's hash and modality;
  - question turns and tutor moves never create rows;
  - model-created ink ids are rejected;
  - the key never appears in the public turn or the evidence route's public fields.
- **Labeling**:
  - a mocked System One response is mapped;
  - p < 0.5 → null;
  - candidate mapping;
  - a 403, timeout or malformed body → `failed` with a code, no learner-facing event and an
    unchanged turn stream;
  - budget exhaustion, a missing key with no charge, the concurrency cap;
  - the turn completes while the labeler is blocked.
- **Web**: `via=spoken` from the card mic, `tap` and `typed` otherwise, and the proxy allowing
  `…/evidence`.

## Live check (labeled live; latency samples)

- 12 synthetic answers through the real route and the background labeler, against Elephant:
  - mixed tap, typed and spoken;
  - wrong, right and partial answers;
  - 2 with planted wrong keys.
- Report label agreement with a hand label, the `key_valid` catches, and label latency (p50 and
  max), plus the turn's first-move time with labeling on versus off.

**Blocker found while writing this brief:** the `.env` `BASETEN_API_KEY` works for Spark Open
(`chat/completions` 200), but every decision-model call returns 403 "please check the api-key".
That covers System One and chat, with Bearer or `Api-Key` auth. Elephant does appear in
`/v1/models`. The key probably lacks decision-model access or credits. Until it is fixed, the
live check cannot pass; mocked work proceeds.

## Completion evidence

- Full backend and frontend suites, `tsc`, changed-file lint and `npm run build`.
- The live run (or the recorded blocker), `docs/handoffs/H4.md`, and the H4 row in Slice status.
- Scoped commits on `feature/evidence-capture`. No push or PR.
