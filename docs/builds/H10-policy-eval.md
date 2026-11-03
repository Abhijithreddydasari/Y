# H10 brief: policy improvement with GEPA (offline)

Status: approved 2026-11-03 (user: gpt-6-luna cross-judge allowed; Spark 1.3 rates given). Branch
`feature/policy-eval`, cut from `main` at `335ddcb`. Roadmap: "H10 — Policy improvement with GEPA".

## Goal

Show, with numbers, that Y can improve its own teaching policy. Score the production policy
(baseline) and a GEPA-evolved candidate on held-out scenarios the optimiser never saw. Report
both honestly, per scenario, with the Meta models' prompts and responses shown. A candidate that
fails the gate is a valid result. The live prompt is never mutated.

## Where the policy lives today

`api/prompts/tutor-v1.md` (`POLICY_VERSION = "tutor-v1"`, loaded as `SYSTEM_PREFIX` in
`api/learning/tutor_turn.py`) is **one prompt with named sections**. The roadmap's names match
its headings exactly:

| Section | Role in H10 |
|---|---|
| `## pedagogy_policy` | evolved |
| `## check_writer` | evolved |
| `## feedback_policy` | evolved |
| `## moves` (schema, artifacts, `because`, `point`) | frozen: it is the wire contract the validator enforces |
| `## personalization` | frozen: H5's measured brief behaviour |

GEPA gets the three sections as three components. A candidate prompt is the seed file with
only those section bodies replaced, and each body is capped at 1.5× its seed length.

## Scenarios (`api/policy_eval/scenarios.json`)

Each scenario has a persona, one hidden misconception, the student's opening question,
`markers` (short phrases whose presence in the tutor's turns shows the belief was named or
probed), a `kind` and a split. 24 scenarios: 8 per persona.

- **Known (9):** the three fixture beliefs of each persona (for example Priya
  `softmax-equalizes`, Tomás `base-rate-neglect`, Amara `entropy-disorder`). The persona's real
  brief names 6 of them as M items; the other 3 (`sqrt-d-normalises`, `stride-keeps-size`,
  `energy-kt-always`) were resolved in the fixture's history, so they test a recurrence.
- **Hidden (15):** five authored beliefs per persona on that persona's topics, which are not in
  its brief. These test whether a check is written to catch a misconception nobody told the
  tutor about. Examples: Priya "layer norm normalises each feature across the batch"; Tomás "a
  larger learning rate always reaches the minimum faster"; Amara "the wavefunction itself is
  the probability of finding the particle".
- **Brief:** compiled by the existing deterministic code (`compile_brief`, `render_brief`) from
  a scratch-SQLite build of the persona fixture. This uses recorded notes and makes no model
  call, so the tutor sees exactly what a judge's "Try as…" turn would see.
- **Splits, stratified by persona and kind:** train 9 (GEPA minibatches), val 6 (GEPA's Pareto
  set) and **held-out test 9** (3 per persona, 1 known + 2 hidden). Test is used only by the
  gate. Each belief appears in one split only.

## One rollout (one GEPA "metric call")

1. **Turn 1, question:** the scenario's question goes through the real `build_messages` path,
   with the candidate's prompt as the system message, the persona's brief, empty session memory
   and no board. It streams through the real `MetaTutor` and `TurnRun`: `TurnValidator`, one
   in-turn repair, and the `ONE_PER_TURN` and question-last rules.
2. **Student:** answers turn 1's check from the hidden belief, seeing only the board text and
   the question (never the key).
3. **Turn 2, answer:** the real `grade()` (verifiers and key audit), then `this_turn`, then the
   tutor's feedback turn with a new check.
4. **Student again:** keeps the belief unless turn 2's teaching explicitly showed why it is
   wrong (the "receptive" rule from `eval_learning.py`, rewritten here).
5. **Judge:** scores both turns against the rubric and writes a short critique. GEPA's
   reflection reads that critique.

The in-turn repair call goes through the same adapter with the candidate's prompt swapped in
(a subclass of `MetaTutor` in `policy_eval/clients.py`). Nothing in `api/learning/` changes.

## Scores (each 0–1; the rollout score is their weighted sum)

| Part | Weight | How it is computed |
|---|---|---|
| Judge rubric | 0.35 | Mean of five 1–5 items, rescaled: names the likely wrong idea; re-teaches it from a different representation; turn-2 check probes the belief with a plausible distractor; correct content; concise and fits a board |
| Resolved | 0.20 | The student's turn-2 answer is correct: the deterministic verifier where one exists, otherwise the judge's correct/incorrect call |
| Probe (deterministic) | 0.15 | A check (turn 1 or 2) carries an option or key that matches a scenario marker, **or** the student, answering from the belief, got turn 1 wrong |
| Addresses (deterministic) | 0.10 | Turn 2's `write`/`say`/`equation` text contains a scenario marker |
| Valid (deterministic) | 0.10 | Accepted moves / (accepted + dropped) over both turns, times 0 for a `failed` turn; schema version checked |
| Length (deterministic) | 0.10 | 1 inside 40–220 words of board and voice text per turn, falling linearly to 0 at 2× |

The deterministic parts are reported separately everywhere, so judge bias can be seen apart
from the measured behaviour.

## GEPA

- Package: **`gepa==0.1.4`**. A dry run resolves it as one package with no extra dependencies.
  It goes into the api venv with `uv pip install`, and into `pyproject.toml` as an optional
  extra `policy-eval`. The Modal image pins its own packages and does not ship
  `api/policy_eval/`, so deployment is unaffected.
- A custom `GEPAAdapter`: `evaluate` runs a batch of rollouts (4 at a time) and returns scores
  and traces. `make_reflective_dataset` gives each component the scenario, the student's answers,
  the tutor's moves, the score breakdown and the judge's critique.
- `max_metric_calls=150`, minibatch 3, module selector round-robin over the three sections,
  `seed=0`.
- If the `gepa` API turns out not to fit, the fallback is a small reflect-and-mutate loop of
  the same shape (Pareto set on val, the same budget), and the report will say so.

## Promotion gate

- Run baseline and candidate on the 9 held-out scenarios, **2 repeats each** (Muse Spark is not
  deterministic at minimal effort).
- **Promote only if mean(candidate) − mean(baseline) ≥ 0.05** and the valid rate does not drop
  by more than 0.02.
- The report also gives a paired bootstrap 90% interval for the difference, and says plainly
  whether that interval excludes 0.
- "Promote" means only that the gate passed. The candidate is written to `docs/reports/`. It
  becomes `api/prompts/tutor-v2.md` only in a **separate commit after the user approves**, and
  it reaches production only through a redeploy the user asks for.

## Models and paid calls

| Role | Model | Why |
|---|---|---|
| Tutor (baseline and candidate) | **Muse Spark 1.3**, `minimal`, strict JSON (Meta) | The production model, so a gain transfers |
| GEPA reflection (rewrites the policy) | **Muse Spark 1.3**, `medium` (Meta) | Architecture doc's choice; this is where the policy is rewritten |
| Simulated student | **Muse Spark Open** on Baseten, `low` (Meta, open weights) | Cheap; already used as the learner in `eval_learning.py` |
| Judge | **Muse Spark Open** on Baseten, `low`, strict JSON (Meta) | Cheap and the same for both arms |

The four main roles are Meta models. **Caveat:** tutor, student and judge are one model family.
That is why judge-free parts carry 65% of the score, and OpenAI `gpt-6-luna` re-judges the
held-out set as a cross-check (user-approved; about 36 more calls). Its verdict is reported
beside the primary one; the gate uses the primary judge, as planned.

Estimates (per call: tutor about 3.6k tokens in and 1.5k out; student 1k in and 1.5k out; judge
4k in and 1.5k out; reflection 8k in and 3k out):

| Run | Rollouts | Spark 1.3 calls | Spark Open calls | Total calls (hard cap) | Tokens (in / out) | Wall time |
|---|---|---|---|---|---|---|
| Smoke | about 12 (2 baseline, GEPA with 6 metric calls, 1 gate scenario × 2 arms) | about 26 | about 36 | about 62 (cap 80) | 0.15M / 0.1M | about 8 min |
| Full | 150 GEPA + 36 gate = 186 | about 390 tutor (repairs included) + ≤ 25 reflection | about 560 (372 student, 186 judge) | about 975 (**cap 1,100**) | 3.0M / 1.6M | about 60 min |

**Cost:** Muse Spark 1.3 is $1.25 per million input tokens, $0.15 cached and $4.25 output (user,
2026-11-03). The full run's Spark 1.3 share is about 1.6M input and 0.66M output tokens, so **about
$5** before caching (the constant system prefix caches). Spark Open on Baseten and gpt-6-luna rates
are not known here; the report lists their token counts.

These are direct local calls. They do not go through the deployed API or its budgets.

**Bounds:**
- a `Budget` object with per-role counters and a hard total cap, checked before every call;
- concurrency 4 per provider;
- one retry with backoff on 429, 5xx or timeout, counted against the cap;
- a JSONL log of every call with role, model, tokens, latency and status, and no headers or keys;
- rollouts cached by (candidate hash, scenario, repeat) in `tmp/policy_eval/`, so a rerun after
  a crash does not pay twice.

## Report (what proves it works)

- `docs/reports/H10-policy-eval.md` and `.json`:
  - the gate verdict;
  - baseline against candidate per held-out scenario, with each score part;
  - means, the interval and the valid rate;
  - the GEPA trajectory (score of each accepted candidate on val);
  - call and token counts per role and model.
- **Diff of the three sections, seed → candidate,** with the reflection model's stated reason
  for each change.
- **Two or three side-by-side examples** on the same held-out scenario: the student's question
  and answer, the baseline's and the candidate's moves (as board text), and the judge's
  critique. The point is to show on screen Meta models doing each job: tutor, student, judge and
  rewriter.
- `docs/reports/H10-candidate-tutor.md`: the full candidate prompt, not wired in.

## Files (all new, offline)

- `api/policy_eval/`: `scenarios.json`, `scenarios.py` (load and validate, splits),
  `rollout.py`, `score.py`, `judge.py`, `student.py`, `budget.py`, `adapter.py` (GEPA),
  `gate.py`, `report.py`, `run.py` (CLI: `smoke`, `optimize`, `gate`, `report`).
- `api/tests/test_policy_eval.py`, all mocked:
  - scenario loading, schema, split disjointness and stratification;
  - section substitution keeps `moves` and `personalization` byte-identical;
  - each score part on fixed turns;
  - the gate at 0.049, 0.05 and a valid-rate drop;
  - the call cap stops before the cap+1th call, with retries counted;
  - an adapter rollout on a fake tutor.
- Docs: this brief, `docs/handoffs/H10.md`, the slice row in `docs/workflow.md`, the reports.
- Not touched: `api/learning/`, `api/prompts/`, `web/`, `deploy/`. No redeploy.

## Commands (from `api`, CMD)

```bat
uv pip install --python .venv\Scripts\python.exe "gepa==0.1.4"
.venv\Scripts\python.exe -m pytest -q tests\test_policy_eval.py
.venv\Scripts\python.exe -m policy_eval.run smoke
.venv\Scripts\python.exe -m policy_eval.run optimize --max-metric-calls 150
.venv\Scripts\python.exe -m policy_eval.run gate
.venv\Scripts\python.exe -m policy_eval.run report
```

## Order

1. Build the module and the mocked tests; run the full backend pytest and `npm test`.
2. Smoke run (about 62 calls, capped at 80) and show its numbers.
3. **Ask** before the full run, with the estimate updated from the smoke run's measured tokens
   and time.
4. Full run, gate and report; handoff and status row; scoped commits; no push.
5. Only if the gate passes and the user approves: a separate commit with
   `api/prompts/tutor-v2.md`. Redeploy only on request.

## Open questions for the user

- Is Spark Open as judge acceptable? Or should held-out also be re-judged by `gpt-6-luna`
  (about 36 more calls)?
- Is the full-run cap of 1,100 calls (about 3M input tokens) acceptable on tonight's credits?
