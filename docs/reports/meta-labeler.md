# Meta evidence labeler: which model, and how accurate?

Run 2026-11-05. All live and paid: 257 calls, 1 of them a 403. Code: `api/policy_eval/label_check.py`, `api/policy_eval/ink_check.py`.
Cases and hand labels: `api/policy_eval/label_cases.json`. Raw results: [meta-labeler.json](meta-labeler.json). Baseline:
[capture check](capture-check.md).

## Verdict

**Muse Spark Open at `reasoning_effort=minimal` is now the default labeler**, on `BASETEN_API_KEY`, with no setting needed.
On this test it matched or beat `gpt-6-luna` on every line and reads ink. The trade-offs:

- It answers slower than the OpenAI call did. Labels run in the background, so a learner does not wait for them.
- A half-right worded answer can be named as a belief at close (see Open issues).

These are the same clear-cut cases I wrote for the baseline, so they show that nothing got worse on clear cases. They are
not a real-world accuracy figure.

## What the keys reach

| Key | Meta models listed | Other |
|---|---|---|
| `MODEL_API_KEY` | `muse-spark-1.1`, `1.2`, `1.3`, `-contributor` variants of 1.2 and 1.3, `muse-wonder-1.0`, `muse-image-1.0`, `muse-voice-transcribe-1.0`, `sam-3.1` | none |
| `BASETEN_API_KEY` | `meta-models/muse-spark-open-1026`, `meta-models/muse-spark-open` (lists, but 403 on a call) | many non-Meta models, including the decision models |

**No "Glimmer" is listed on either key**, and no model named as a smaller Meta text model. The `-contributor` variants were not
tried, since the name suggests a different data arrangement and nothing here needs them.

## Candidates

One call each, all through the strict schema: every model below answered and parsed.

| Model | Effort | Sequential latency (6 calls) | Top misconception | Outcome | Clean answers added to the ledger | "Other" mass ≥ 0.15 on clean answers | Miss type taken |
|---|---|---|---|---|---|---|---|
| **Muse Spark Open** | minimal | **p50 2.8 s, max 4.2 s** | 26 of 26 | 26 of 26 | 0 of 14 | 3 of 14 | 32 of 36 |
| Muse Spark 1.1 | minimal | p50 3.3 s, max 3.6 s | 26 of 26 | 25 of 26 | 0 of 14 | 3 of 14 | 34 of 35 |
| Muse Spark 1.3 | minimal | p50 4.75 s, max 5.1 s | 26 of 26 | 26 of 26 | 0 of 14 | 1 of 14 | 34 of 36 |
| `muse-spark-1.2`, `muse-wonder-1.0` | minimal | one call only: 2.3 s, 3.7 s | not run | not run | not run | not run | not run |

Muse Spark 1.3 was the cleanest on bare slips, and it is one setting away (`EVIDENCE_LABEL_PROVIDER=meta`).

## Default labeler against the baseline

Same cases. Run 2 is a repeat, since a single run hides variance.

| Test | `gpt-6-luna` | Spark Open, run 1 | Spark Open, run 2 |
|---|---|---|---|
| Top misconception | 26 of 26 | 26 of 26 | 26 of 26 |
| New belief reported as "other" | 6 of 6 | 6 of 6 | 6 of 6 |
| Outcome, where the model decides | 22 of 26 (all 4 generous) | **26 of 26** | **25 of 26** (1 generous) |
| Clean answers wrongly added to the ledger | 0 of 14 | 0 of 14 | 0 of 14 |
| Injection marked correct | 0 of 2 | 0 of 2 (p 0.01, 0.01) | 0 of 2 (p 0.01, 0.02) |
| Miss type taken (p ≥ 0.5) | 22 of 35 | 32 of 36 | 33 of 35 |
| Failures | 0 of 42 | 0 of 42 | 0 of 42 |

The one miss in run 2 is `g2`, "so that they add up to one", also over-credited by the baseline and by Muse Spark 1.1.

Miss type counts confidence, not accuracy: mistake types are not hand labeled. Run-1 cases `e1`, `e3` and `e4` are bare numbers
with some "other" mass; the close guard below handles them.

**Naming at close (one answer per session, Spark Open as both labeler and namer):**

| Answers | `gpt-6-luna` + Spark Open, with the fix | Spark Open for both |
|---|---|---|
| New real misconceptions named, accurately | 6 of 6 | 6 of 6 (read by me, all accurate) |
| Bare numeric slips named | 0 of 4 | 0 of 4 |
| Injections named | 0 of 2 (flagged 2 of 2) | 0 of 2 (flagged 0 of 2) |

## Ink crops (new check)

The answer exists only in the image, through the real capture store, board assets and `observations.label`. Seven crops are
jittered pen strokes, three a handwriting font, plus a scribble and a written injection.

| Check | Spark Open | Muse Spark 1.3 |
|---|---|---|
| Outcome as expected | 12 of 12 | 12 of 12 |
| Misconception, where scored | 2 of 2 | 2 of 2 |
| Written injection marked correct | no (unanswered, p 0.9) | no (unanswered, p 0.9) |
| Scribble | unanswered, p 0.53 (incorrect 0.42) | unanswered, p 0.70 |
| Label end to end, 12 at once on 4 slots | p50 9.3 s, max 17 s | p50 11.9 s, max 27 s |
| Failures | 0 | 0 |

End-to-end ink times include the queue and a burst of 12, which a learner does not produce. Spark Open's maximum is over the
15 s provider timeout only because that time includes the queue, and no call timed out.

`gpt-6-luna`'s only ink result is the earlier 2 of 2 in a font; it was not re-run here, so this is not a like-for-like comparison.
**A person's real stylus handwriting is still untested** on any model.

## Latency

`gpt-6-luna` calls were 1.2 s on the deployed path and about 2–4 s in the H5 run. Spark Open is p50 2.8 s sequentially, and
under 4 at once run 2 was p50 3.3 s, max 7.5 s. So the provider timeout is 15 s rather than 8 s. Close still waits at most 20 s
for labels.

## How it was built

The wiring is unchanged: same `EvidenceLabelProvider` protocol, setting, questions, budgets, slots, dedupe, failure codes and
provenance. Chat models have no typed decision API, so a strict JSON schema asks for one probability per option per question,
and the server normalizes them. A malformed reply is `provider_invalid_response`, never a guess. The prompt was written before
the first run and was not tuned against the hand labels. A row records `labeler=baseten` and the model
`meta-models/muse-spark-open-1026`.

## Open issues

- **A half-right worded answer can become a named belief.** New case `g3`, "when you can multiply their probabilities": labeled
  partial, correctly, 3 of 3, but with "other" mass 0.34–0.44, over `FLAG_AT = 0.3`. Close then named a belief from it, 2 of 2.
  `g2` was not flagged, 2 of 2. The baseline was not measured on `g3`. Left as is, since behaviour was to stay the same; a
  likely fix is to require p(incorrect) to dominate before flagging on "other" alone.
- **Probabilities cluster near 0.9–0.98.** They are model-reported, with no calibration measured, and the learner model updates on
  them directly.
- Added case `e5`, a slip in words: 3 of 3 clean, not named. It and `g3` were run only on Spark Open, so the 26-case totals above
  exclude them.
- The hand labels and answers are mine, and each naming run saw one answer per session.
