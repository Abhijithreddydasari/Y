# H7 brief: study loop extras

Status: confirmed and built, 2026-11-03 ([handoff](../handoffs/H7.md); teach-back cut). Branch `feature/study-loop`, cut from `main` at
`b8583b3` (H6 merged). P1. Gate: a session can run warm-up → teach → checks → exit ticket →
close with no dead ends. Practice and capture review stay optional.

## Learner story

Session 2 opens. A small "Warm-up · 2 due" pill sits above the composer, offering Start or Skip.
Start draws a review card from session 1 on the board, and the learner answers it the usual way.
They can also ignore it and ask a question. While a card waits, a Hint button steps from a nudge
to a worked step, then to the answer. When the learner presses End session, Y offers "One quick
check before you go". The learner answers it, gets one line of feedback, and the session seals.
A Canvas list in the menu reopens an earlier board.

## Scope, in priority order (cut from the bottom)

### 1. Warm-up review cards (no model call to pick or draw them)

- `GET /learning/review` (owner) returns up to 3 due items from the latest revision.
  - **Due** means one of three things: the predicted retention `2^(−Δt/half_life)` is below 0.5;
    the mean is below 0.6 (shaky); or the concept has an active or suspected misconception.
    Shaky and misconception items count, so the demo's session 2 has something due minutes after
    session 1, before any 24 h half-life has passed.
  - Ranked by misconception, then low retention × low mean.
  - **Only check evidence counts.** Predicts borrow a concept (H5 note), so they never make
    anything due.
  - Each item re-asks the learner's **latest check on that concept** from an earlier session. The
    stored question, options and key come from `question_json`, and the key stays server-side.
- A new turn kind `review` (`TurnInput.kind`, with `concept`). The server builds the moves itself:
  a `seg` "Warm-up", then the stored check. The turn is stored like any other turn, ends `waiting`,
  and streams on the existing SSE path. No paid call, and a replay works.
- **The answer is the normal answer turn**, so H4 records evidence and the stored concept and
  dimension are kept. THIS TURN marks it `review: true` so that feedback stays short. After it,
  the pill offers the next due item ("Next · 1 left") or Done.
- **Never blocking**: the composer always works. Asking a question closes the card, which is the
  existing rule. Skip hides the pill for this session. The pill shows only before the session's
  first question, or between reviews.

### 2. Exit ticket

- End session first offers "One quick check before you go: Take it / Just end". Just end closes
  the session as before. The offer appears only when the session has at least one answered check
  and no exit ticket yet.
- Turn kind `exit`: one model turn that THIS TURN limits to one short `seg` and one check on the
  session's main concept (the concept with the most evidence this session; the first question as
  a fallback). The card waits as usual.
- Answering it is a normal answer (evidence) with one-line feedback. The client then runs the
  existing close automatically, so the close summary includes the ticket. A failed exit turn
  falls back to an explicit End session button. It never traps the learner.

### 3. Hint ladder

- A Hint button on the open card's controls: 1 nudge, 2 worked step, 3 reveal. Level 3 is the
  existing "Just tell me".
- `POST /learning/sessions/{sid}/tutor/hints {qid, level}`: one non-streaming Muse Spark call
  (`minimal` effort, strict JSON `{hint}`, ≤ 300 tokens, 10 s timeout, charged to the tutor
  budget). The prompt includes the key and the rule that level 1 must not reveal it.
- Stored in a new table `learning_hints`, UNIQUE(session_id, qid, level). A repeat returns the
  stored text with no call. Levels must be taken in order.
- Evidence: `record_evidence` puts the hint ids used for that qid into
  `Assistance.hint_ids`. The existing ×0.7 hint factor then applies. The text shows in the card
  controls and returns on refresh with `GET …/tutor` (`open.hints`).

### 4. Canvas list

- `GET /learning/sessions` (owner, latest 30): id, created time, open or sealed, title (first
  question, otherwise "Untitled canvas") and turn count.
- A "Canvases" menu item in Studio and Mobile opens a list. Picking one sets the stored board
  session and reloads.
- A sealed canvas opens to view. Its composer says "This canvas is sealed. Start a new session
  to ask", with a New session button. That keeps it from being a dead end.

### 5. Voice teach-back (P1, first to cut)

- After the exit ticket, or from the card controls: "Explain it back" is a free check, built
  without a model call: "In your own words, explain <concept>", with `dim=understand`. The
  session's segment goals serve as its key (the rubric).
- It is answered by the mic through the existing spoken path, then labeled by the decision model
  (outcome and reasoning). **Planned cut if the time after items 1–4 runs short**, as the roadmap's
  cut order says.

## Exclusions

No new model for picking reviews. No spaced-repetition scheduler beyond the existing half-life.
No changes to the profile reducer. Concept labels from question text (H6 note) are left to H8;
warm-up cards show the stored question, so they do not need one.

## Contract changes (to note in the handoff)

- `TurnInput.kind` gains `review` and `exit`, plus an optional `concept`.
- `open` in `GET …/tutor` gains `hints`. A new table: `learning_hints`.
- `open_question`, `session_memory` and the topic choice treat `review` and `exit` turns as
  normal turns.

## Failure and ownership

All routes are owner-scoped and proxied. A closed session returns 409 to review, exit and hint.
Hint failure shows "No hint right now", and the card stays open. Review with nothing due returns
an empty list, and no pill appears. Stop works on every turn kind.

## Tests and checks

- Mocked backend: due selection (retention, shaky, misconception, predicts ignored), review turn
  build, replay and answer evidence; exit-turn THIS TURN; hint order, dedupe, budget, key-leak
  rule, and `hint_ids` in the observation; the session list and ownership.
- Frontend: pill flow, exit offer → ticket → auto close, the hint ladder in the card, the Canvas
  list, and the sealed-canvas composer.
- Live (paid, labelled live, latency recorded): 3 hint calls, 2 exit turns.
- Full suites, tsc, lint and build. An in-app browser journey of the gate path: warm-up →
  question → check → hint → exit ticket → close.
