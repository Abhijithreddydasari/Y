# Demo personas ("Try as…")

Status: built 2026-11-03 ([handoff](../handoffs/personas.md)). User decisions at confirmation: notes are recorded once from
Muse Spark 1.3 (paid), and End session can seal a board into another of the viewer's minds (default: the board's own). Branch `feature/personas`, cut from `main` at `361aab2` (H8 board UI merged).
Coding freezes 2026-11-03 22:00 IST.

## Learner story

A judge opens Y, taps **Y → Settings → Try as…** and picks a learner. The Mind shows that learner's three weeks of
history: a replay and scrubber over several sealed revisions, misconception halos, `builds_on` / `confused_with`
synapses. Review lists due checks, and a warm-up re-asks one. The judge asks a question with Memory on, so the first
turn cites that learner's history (`because` chip). They answer the checks, press End session, and the Mind grows by one
revision. **Reset persona** puts the learner back to how they started. **Your own** returns the judge to their own
anonymous profile, untouched.

## Personas (authored fixture, not model output)

| Key | Learner | Shape |
|---|---|---|
| `priya` | **Priya Nair**, MSc ML student writing a small LLM inference engine | ML-heavy: dot products and matrix shapes (beginner), softmax, scaled dot-product attention, multi-head attention, positional encodings, layer norm, cross-entropy, backprop through attention, KV cache memory and reuse, FlashAttention tiling. Misconceptions: *softmax makes the weights roughly equal* (active, recurring), *the KV cache stores queries too* (suspected), *√d scaling normalises scores into probabilities* (resolved later). |
| `tomas` | **Tomás Ortega**, final-year robotics undergrad on a vision team | CV + maths: matrix multiplication (beginner), convolution and padding/stride output size, receptive fields, pooling, eigenvalues/eigenvectors, SVD and PCA, gradient descent, momentum and learning rate, Bayes' rule, Gaussians and MLE, homographies. Misconceptions: *stride doesn't change output size* (resolved), *eigenvectors of any matrix are orthogonal* (active), *base-rate neglect in Bayes* (suspected). |
| `amara` | **Amara Okafor**, first-year physics PhD student | Quantum and statistical mechanics: complex numbers and derivatives (beginner), wavefunctions and Born rule, commutators, uncertainty principle, harmonic oscillator ladder operators, spin-½, perturbation theory, Boltzmann distribution, partition function, entropy and free energy, Fermi–Dirac / Bose–Einstein. Misconceptions: *uncertainty is caused by measurement disturbance* (active), *entropy just means disorder* (suspected), *⟨E⟩ = kT for any system* (resolved). |

Each persona: 7 sessions spread over the last ~21 days, 5–7 answered checks each (≈45 observations), mixed
recall / understand / apply / analyze / transfer and mixed tap / typed modality, a few hint uses and one revealed
answer. Mastery is deliberately uneven (strong recall, weak transfer on graduate topics; beginner topics solid but
fading). The latest sessions are 1–3 days old, so Review has fading and misconception items.

## Design

**Real pipeline, authored inputs.** `api/learning/personas.py` builds a persona into an owner from
`api/learning/fixtures/personas/<key>.json` (sessions → checks → answers with outcome/misconception distributions,
plus cited notes and links per session):
1. `CaptureStore.create_session` and a stored `question` tutor turn (heading + the checks, `timing.seed=true`) so
   Canvases show titles and a sealed board opens to view.
2. Each answer goes through `ObservationStore.capture_answer` (real verifier, key audit, dedupe), then is finished as
   the labeler would finish it, with the fixture's soft label and `labeler="seed"`.
3. Close uses the close route's own steps: `begin_close` → `sealed` → `keep_cited` / `keep_named` / `keep_links` on
   the fixture's notes, names and links → `profile.reduce` → `ProfileStore.write`. Consolidator `seed-fixture`; the
   close summary carries `seed: true`.
4. Times are backdated (`at`), so decay, half-lives and due items come out of the reducer, not the fixture.

IDs are `uuid5(owner, persona, session, qid)`, so a rebuild into the same owner is a no-op (idempotent), and the same
fixture always gives the same beliefs. No paid calls anywhere in seeding.

**Seed script.** `api/scripts/seed_personas.py` builds the three templates into fixed template owners
(`uuid5("y-persona-template", key)`, no cookie token, so nobody can sign in as them), prints each persona's revisions,
belief count, misconceptions, links and due reviews, and does nothing on a second run.

**Private copies.** A "copy" is the same deterministic build into a fresh owner the viewer holds; it equals the template
without remapping evidence ids inside revision JSON.
- New tables: `learning_persona_copies(viewer_owner_id, persona, copy_owner_id, created_at)` PK `(viewer, persona)`,
  and `learning_viewer_state(viewer_owner_id PK, active_persona)`.
- `require_owner` resolves cookie → viewer → active copy owner. Every existing route and ownership check runs
  unchanged against that effective owner, so one judge's copy is unreachable from another cookie and the template is
  never written to.
- Routes (proxied): `GET /learning/personas` (list with name, blurb, topics, active), `PUT /learning/personas/active`
  `{persona: key | null}` (builds the copy on first pick, ~0.3 s), `POST /learning/personas/{key}/reset` (deletes the
  copy owner's rows and rebuilds). `POST /identity` also returns `persona`.
- Bounds: 3 copies per viewer at most (one per persona), a reset deletes the old copy, copy/reset limited to 20 per
  viewer-hour and 300 globally through the existing budget table. Copies follow the 30-day identity expiry.

**Provenance in the UI.** Labeler `seed` → Trace shows "Seeded (demo)" for those labels, and a sealed seeded close
reads "Seeded demo history, no model call". Links gain provenance `seed` ("seeded demo"), notes show "seeded". Live
evidence added later in a persona copy is labelled exactly as today (OpenAI / verifier / Spark Open).

**Frontend.**
- Settings gets a **Try as…** section: "Your own" plus three cards (name, one-line backstory, topics), the active
  one marked, and **Reset persona** for the active persona (confirm first).
- A small "As Priya" pill near the Y button while a persona is active.
- The board session key is per profile (`y_board_session_v1` for your own, `y_board_session_v1:<key>` for a persona),
  so switching never sends one owner's session id to another. Switching reloads the page once, so every hook starts
  clean.

## Contract changes

`Observation.labeler` adds `"seed"`; `ConceptLink.provenance` adds `"seed"`; TypeScript mirrors follow.
`capture_answer` gains an optional `at`. No other H0 contract changes.

## Exclusions

No Google sign-in, no emails, no persona chat or role-play, no live model calls during seeding, no changes to the
reducer, brief or labeler logic.

## Tests (mocked)

- Seed idempotence: building twice gives one set of rows and the same latest revision JSON.
- Seed goes through the pipeline: revisions ≥ 5, misconceptions active/suspected/resolved, links of both kinds, due
  reviews > 0, every observation `labeler="seed"`.
- Copy isolation: two cookies pick the same persona and get different owners; one viewer's End session changes only
  its copy; the template's revisions are unchanged.
- Ownership: a session from a persona copy is 404 for "Your own" and for another viewer; persona routes need a cookie.
- Reset: after a live session, reset restores the template's revision count and beliefs.
- Switch back restores the viewer's own profile; frontend tests for the picker and the per-profile session key.

## Checks and acceptance

Full backend and frontend suites, tsc, changed-file lint, build. Browser: pick each persona and check Mind, Review and
warm-up; for one persona, a **live** ask → answer → End session, then the Mind shows the new revision and the next
session's first turn cites the persona's history (Memory on). Then `docs/handoffs/personas.md`, a slice status row and
scoped commits (API, web, docs). No push or PR.
