# Personas handoff: "Try as…" demo learners

Status: done, 2026-11-03. Branch `feature/personas`, cut from `main` at `361aab2`. Brief:
[personas](../builds/personas.md). No push, no PR.

## What changed for a learner (or a judge)

- **Y → Settings → Try as…** lists **Your own** and three demo learners, each with a backstory and topics:
  - **Priya Nair**: ML, attention and the KV cache.
  - **Tomás Ortega**: CV and maths.
  - **Amara Okafor**: quantum and statistical mechanics.
- Picking one reloads the board as that learner. An **"As Priya"** pill sits above the Y button and opens Settings.
- Each learner arrives with three weeks of history:
  - 7 sealed revisions, so the Mind has a replay and a scrubber;
  - about 16 concepts across all five dimensions;
  - active, suspected and resolved misconceptions;
  - `builds_on` and `confused_with` links;
  - Spark 1.3 teaching notes;
  - 3 due Review items and a warm-up.
- **Reset Priya** (with a confirm) throws the copy away and rebuilds it from the template. **Your own** returns to
  the browser's own anonymous profile, untouched.
- **End session saves to** (in Settings) seals the current board into another of this browser's minds:
  - into your own from a persona board;
  - into a persona from your own board.

  The default is the board's own mind. The arc's End session hint names the target, and the close message says
  "Session saved to Tomás's mind (revision 8)".
- Seeded history is labelled as seeded everywhere:
  - Trace shows "Seeded (demo, no model)" for the labels, "Seeded demo history (no model)" for the turn, and
    "Seeded demo history (notes recorded earlier)" for the close;
  - Mind links read "seeded demo history".

## Design as built

- **Fixtures.** `api/learning/fixtures/personas/<key>.json` are authored: 7 sessions, about 36 checks, the persona's
  named beliefs and authored links.
- **Notes.** `<key>.notes.json` were **recorded live once from Muse Spark 1.3** (user's choice) by
  `scripts/record_persona_notes.py`: 21 calls, 8–20 s each. That script sends the close route's own evidence
  payload and notes prompt. Cites are stored as `#j` (the session's j-th check) and mapped onto each owner's ids.
- **Build** (`personas.PersonaStore.build`), in order:
  1. `create_session` and a stored question turn (`timing.seed`);
  2. `tutor_turn.grade` and then `ObservationStore.capture_answer`, backdated with the new `at`;
  3. `claim(charge=False)` and `finish` with the fixture's soft label (`labeler="seed"`);
  4. `begin_close`, `sealed`, `keep_cited`, `keep_links`, `profile.reduce` and `ProfileStore.write`.

  The close summary carries `seed: true`. Decay, half-lives and due items come from the reducer. IDs are uuid5 of
  the owner, so a rebuild is a no-op.
- **Copies.** `learning_persona_copies(viewer, persona) → copy_owner` and `learning_viewer_state(viewer,
  active_persona)`.
  - A copy owner is an identity row whose token hash is of a secret nobody holds, so it cannot sign in.
  - `require_owner` now resolves cookie → viewer → active copy. Every existing route and ownership check runs
    unchanged against that owner; the new `require_viewer` serves the persona routes.
  - Builds cost 0.23–0.36 s for a copy and 0.23–0.28 s for a reset (SQLite, this laptop).
  - Limits are 20 per viewer and 300 globally per hour; there is at most one copy per persona per viewer.
- **Reset.** `wipe` deletes every row of the copy owner, children first, then rebuilds into the same owner.
- **Close into.** `POST …/close {into: "own" | key}` moves an open, unsealed session's `sessions`, `observations` and
  `attempts` rows to the target. The target is the viewer or one of its copies; a copy is built if missing. The
  close then runs as usual. The response adds `persona` (the copy's name, or null).
- **Routes** (proxied): `GET /learning/personas`, `PUT /learning/personas/active {persona|null}` and
  `POST /learning/personas/{key}/reset`. `POST /identity` also returns `persona`.
- **Web.**
  - `lib/personas.ts` keeps a local mirror of the active persona, set from `/identity`.
  - The board session key is per profile: `y_board_session_v1` for your own, `y_board_session_v1:<key>` for a
    persona.
  - Switching or resetting reloads the page.
- **Seed script.** `scripts/seed_personas.py` builds the three templates into fixed owners and prints a summary.
  A second run seals nothing. "Try as…" does not need it: it builds the same fixture into each copy.

## Where concepts come from

- **Demo learners: authored.** Every concept id in the fixtures was written by hand, for example
  `attention.softmax`, `linalg.eigenvectors` and `stat.partition-function`. So were each check's dimension, the
  named misconceptions and the authored links. The only LLM output is the teaching notes and 1–4 links per persona,
  recorded once from Muse Spark 1.3.
- **Live sessions: chosen by the LLM, with no fixed list.**
  - The board-move schema requires every check to carry a `concept` id and a `dim`. The tutor (Muse Spark) makes
    these up for each question.
  - The reducer creates a Beta belief the first time it sees a concept × dimension. A mind holds only the topics a
    learner was checked on.
  - The tutor prompt (`personalization`) asks the tutor to reuse the concept ids in the brief. That is how
    Tomás's live Bayes question attached to his seeded `prob.bayes-rule`.
  - Misconception mass comes from the OpenAI labeler's probabilities. Belief names and `builds_on` /
    `confused_with` links come from Spark Open at close, and each must cite answers.
  - Mind regions ("Attention", "Linear algebra") appear to come from the concept id's prefix, not a separate
    classifier.
- **Weak spot.** Because the LLM picks the ids, one idea can end up under two ids. In the live run, a new base-rate
  belief sat beside the seeded one instead of merging into it (see Open). A fixed taxonomy, or a merge step at
  close, would fix that later.

## Contract changes

- `Observation.labeler` adds `"seed"`; `ConceptLink.provenance` adds `"seed"`. The TypeScript mirrors are updated.
- `carry_links` merges provenance by precedence (model > system > seed), so two seed links stay seed. Before, they
  became system.
- `capture_answer(at=)` is optional. `TraceTurn.seed`, `TraceClose.seed` and `CloseSummary.persona` are new.

## Commits

| Commit | Scope |
|---|---|
| `5d75994` | API: fixtures and recorded notes, personas builder and store, routes, close into, trace seed flags, seed and record scripts, tests |
| `b1e42dd` | Web: Try as… picker, persona pill, save-to choice, per-profile session key, seed labels in Trace and Mind, tests |
| this commit | Docs: brief, handoff, slice status |

## Checks

### Mocked or offline

| Check | Result |
|---|---|
| Backend `pytest -q tests scripts/test_teacher.py` | 394 passed (+10 in `test_personas.py`: idempotence and determinism, pipeline shape ×3, copy isolation and template untouched, switch back, reset, close into both ways, cookie and unknown persona, seeded trace) |
| Frontend `npm test` | 31 files, 172 passed (+2: picker and save-to, per-profile session key) |
| `tsc --noEmit` (web) | exit 0 |
| Changed-file lint (15 files) | exit 0 |
| `npm run build` | exit 0 |
| `seed_personas.py` twice on a scratch DB | 7/7/7 sealed, then 0/0/0; no seeded check trips the key audit |

### Live (paid; in-app browser, `next start` on 3018 → API on 8116, scratch DB)

- **Notes recording:** Muse Spark 1.3, 21 calls, 21–23 notes per persona kept. 1–4 model links per persona; the
  rest are authored.
- **Each persona**, all three picked through the API, Priya and Tomás also in the UI:
  - Priya: the pill, warm-up "3 due", and Review listing softmax (misconception), KV cache (misconception) and
    multi-head (fading).
  - Priya's Mind: "Session 7 · revision 7" with replay.
  - Tomás and Amara (API): 7 revisions each, canvases titled by session, consolidator
    `seed:muse-spark-1.3 (recorded)`.
- **Tomás, live journey:**
  1. The warm-up re-asked his eigenvector misconception check (no model call). Answering it correctly gave a live
     feedback chip "↺ Building on your orthogonal-eigenvectors mix-up", with "Using 24 items from earlier sessions".
  2. Asked about Bayes with a doubled false-positive rate. The first move was "↺ Tackling your base-rate mix-up head
     on", citing his seeded suspected misconception.
  3. Answered 2 wrong, then 1 right.
  4. End session → Just end. Revision 7 → 8: 4 answers sealed, all labeled `openai/gpt-6-luna`. Spark Open wrote 3
     notes in 7.3 s. A new active belief "ignores base rate…" appeared (strength 1.15).
  5. A new session's first turn opened "↺ You jumped to flagged means spam last time".
- **Switching back and reset:**
  - Your own had 0 revisions; Tomás 8 → Reset → 7; Priya stayed at 7.
  - The close-message naming fix ("Tomás's mind") was tested by unit test, not re-run live.

Not run: Postgres, Mobile layout of the pill (positioned above the bottom bar), and close-into in the browser
(covered by mocked tests).

## Open

- **Seeded and live beliefs stay separate.** Tomás's live close named a new belief (`belief-ignores-base-rate…`)
  beside the seeded `belief-base-rate-neglect`. They are not merged, because the labeler offers the earlier entry
  as a candidate but Spark Open's naming makes a new id.
- **Review shows "Memory 0%"** on most seeded items. Retention is the minimum over a concept's dimensions, and
  2–3-week-old dimensions with short half-lives are near 0. This is the reducer's real output.
- **Reset discards everything learned in the copy**, including an open board session in it, by design.
- **Expiry.** Copies follow the viewer's 30-day identity. Expired copies are not garbage-collected yet; H9 could
  add a sweep.
