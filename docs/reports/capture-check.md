# Capture check: is evidence labeled and named correctly?

Run 2026-11-04. All live and paid. Code: `api/policy_eval/label_check.py`. Cases and hand labels, written before
the run: `api/policy_eval/label_cases.json`. Raw results: [capture-check.json](capture-check.json).

## Verdict

- **Right or wrong, and which belief:** good on this test.
- **One bug found and fixed in code, not deployed:** a single arithmetic slip could become a named "belief" in the
  learner's profile. Production still has the old behaviour until the API is redeployed.
- **Still untested:** real stylus handwriting, and how transcription errors affect spoken answers.

## 1. Deployed path (https://ask-y-event.vercel.app, one session)

| Step | Result |
|---|---|
| Wrong free-text answer ("softmax makes all the weights roughly equal") | `labeled` by `openai/gpt-6-luna`; outcome incorrect (p 0.93); other misconception 0.8; 1.4 s end to end, 1.2 s provider |
| Wrong multiple-choice answer on the same belief | `labeled`; verifier says incorrect; that option's misconception 0.99 |
| End session | Revision 0 → 1 from `meta-models/muse-spark-open-1026`; both answers grouped under one active belief, "treats softmax as making all weights roughly equal for an even average", citing both |

One session only. This confirms the deployed keys and path work, not accuracy.

## 2. Labeler against hand labels (`gpt-6-luna`, 42 typed answers, 0 failures)

| Test | Result |
|---|---|
| Top misconception, wrong multiple-choice option holds the belief | 8 of 8 |
| Top misconception, a different wrong option with an unrelated earlier belief listed | 4 of 4 |
| Recurrence: reworded free answer matched to the earlier belief, with one decoy listed | 8 of 8 |
| New belief, nothing listed: reported as "other" | 6 of 6 |
| Correct answers in other words: outcome correct, no misconception | 6 of 6 |
| "I don't know" answers: unanswered, no misconception | 2 of 2 |
| Listed belief wrongly added to the ledger on a clean answer (slips, correct, unanswered, injection) | 0 of 14 |
| Outcome, where the model decides | 22 of 26 |
| Injection attempts marked correct | 0 of 2 (p correct 0.02 and 0.04) |

**The 4 outcome differences all lean generous:**

| Answer | Hand label | Label |
|---|---|---|
| "so that the scores turn into probabilities" | incorrect | partial, 0.55 (incorrect 0.41) |
| "the photon you use to look at the electron kicks it" | incorrect | partial, 0.98 |
| "each head looks at a different subset of the tokens" | incorrect | partial, 0.71 |
| "so that they add up to one" (half the key) | partial | correct, 0.63 |

So a learner holding a wrong belief can still earn about half credit on mastery, while the belief itself is
still flagged.

Mistake type was taken (p ≥ 0.5) on 22 of 35 misses, better than the earlier 1 of 7, but this measures confidence,
not accuracy, since mistake types were not hand labeled. It also called "I don't know" a structural miss (0.53).

## 3. Naming at session close (`gpt-6-luna` + Spark Open, 12 answers, each its own session)

| Answers | Flagged for naming | Named as a belief |
|---|---|---|
| New real misconceptions | 6 of 6 | 6 of 6, all accurate |
| Bare numeric slips | 4 of 4 | **4 of 4** |
| Injection attempts | 2 of 2 | 0 of 2 |

**The bug.** A bare number gets high "other misconception" probability (0.38–0.66), which clears `FLAG_AT = 0.3` in
`consolidate.flagged`, and Spark Open then writes a reason:

| Answer | Named belief | Reading |
|---|---|---|
| `54` for 7 × 8 | "recalls product of 7 and 8 as 54" | invented |
| `13` for the derivative of x³ at 2 | "adds 1 to the correctly evaluated power-rule derivative" | invented |
| `26.2` for √512 | "overestimates square root magnitude without checking by squaring" | invented |
| `74` for conv parameters (76) | "counts bias per input channel (2) instead of per filter (4)" | plausible: 72 + 2 = 74 |

The effect: the next session's brief can treat a typo as a possible misconception.

**The fix (`consolidate.flagged`), not deployed.** A number typed or spoken as the whole answer, flagged only as
"another misconception", is held out of naming until a second flagged answer appears on the same concept. It is
still flagged if the labeler matched a known belief, and tapped options and worded answers are unaffected.

Live re-run with the fix, same 12 answers:

| Answers | Flagged for naming | Named as a belief |
|---|---|---|
| New real misconceptions | 6 of 6 | 6 of 6, all accurate |
| Bare numeric slips | 0 of 4 | 0 of 4 |
| Injection attempts | 2 of 2 | 0 of 2 |

**The cost of the fix:** a real misconception shown only by one bare number now waits for a second answer before it
is named. It can still be picked up sooner if the labeler matches it to a known belief. Two separate slips on one
concept are released to Spark Open, which may still name them; that case was not run live.

## Limits

- I wrote the answers and the hand labels, and most are clear-cut, so these are easier than real learners. Treat
  26 of 26 as "works on clear cases", not as a real-world accuracy.
- Each recurrence case listed one decoy; a real profile can list more.
- Naming ran one answer per session; a real close sees several answers together.
- Typed text only. No real stylus ink and no real speech.
