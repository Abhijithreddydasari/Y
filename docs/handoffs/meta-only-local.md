# Meta-only and local handoff

Branch `feature/meta-only-local`, cut from `main` at `543d991`. Not pushed, not deployed.

## Part 1: Meta evidence labeler (done)

Default labeler is now Muse Spark Open at `reasoning_effort=minimal`, on `BASETEN_API_KEY`, with no setting needed. The wiring is
kept: `EVIDENCE_LABEL_PROVIDER` also takes `meta` (Muse Spark on `MODEL_API_KEY`), and `baseten` stays opt-in. The OpenAI labeler was later removed (below). No
fallback between providers. Full measurements: [report](../reports/meta-labeler.md).

**Provider timeout is 15 s** for this labeler (8 s for the others); the rest of the limits are unchanged.

### Checks

| Kind | Check | Result |
|---|---|---|
| Live | 42 cases, two runs, against `gpt-6-luna` | Misconception 26 of 26 twice (baseline 26), outcome 26 and 25 of 26 (baseline 22), ledger false adds 0 of 14, injections 0 of 2 |
| Live | Naming at close | 6 of 6 beliefs, 0 of 4 slips, 0 of 2 injections |
| Live | Ink crops, synthetic strokes and a font | 12 of 12 |
| Live | Latency, sequential | p50 2.8 s |
| Mocked | Backend pytest | 450 passed |
| Mocked | Frontend `npm test`, `tsc`, changed-file lint, `npm run build` | 195 passed, exit 0, exit 0, exit 0 |
| Not run | Real stylus handwriting | untested on any model |

Mocked: `tests/test_meta_labeler.py` covers the request schema, normalizing, ink crops, malformed replies, status codes, the
default with no setting, no fallback, and one ink answer end to end with provenance. Tests never reach a provider.

### For the user

- **Your local `.env` has `EVIDENCE_LABEL_PROVIDER=openai`, which overrides the default.** Delete that line to use the Meta labeler.
- **Production still uses OpenAI** until both are done: remove `EVIDENCE_LABEL_PROVIDER` from `deploy\.env.modal`, update the
  secret, and redeploy. Commands in `deploy/README.md`. Not done here.

### Open

A half-right worded answer can be named as a belief at close. See the report.

## Part 2: event repository, on two keys

**Why:** organizers require a repository created on or after Oct 26, holding only event work, with pre-event code as a dependency
fetched at a pinned commit. `Y` was created May 6, and 44% of its code lines predate kickoff.

**How:** `tools/sync_submission.py` builds it and never pushes. Re-run it after any change.
- Foundation: a tag on `Y`, built on `9f0ca92` (last pre-event commit). One commit keeps 75 old files the app uses; the next adds this
  week's edits to them.
- `ask-Y`: the real event commits with original dates and messages, filtered to files created during the event, plus `submission/*`
  moved to the root. It stops if a pre-event commit or file reaches the output.
- `npm run setup` fetches the tag, checks the commit hash, lays the files in, installs and creates `.env`.

**History:** 121 of this branch's commits at last count, first dated Oct 29, 13 of 14 pull request merges. Left out: commits touching
only old files, and the Oct 27 merge of pre-event work. All of it remains in `Y`.

**Re-sync caveat:** deleting an event file, or adding a path that had a different history, rewrites earlier commits, and `ask-Y` then
needs a force push. Adding and editing files only appends.

**Trap found live:** do not list foundation files in `.gitignore`. Tailwind skips ignored files (also `.git/info/exclude`, and an
explicit `@source` did not help), so the board's `h-dvh` was missing and its canvas had height 0, while tests and the build passed.
They show as untracked instead.

**First-run fixes:** web proxy defaults to 8101; legacy service called only when named; `torch` and `safetensors` moved to a `legacy`
extra (79 s setup, 90 MB venv); older assessor off unless selected; a voice that cannot speak is left out of the picker.

### Checks

| Kind | Check | Result |
|---|---|---|
| Mocked, fresh copy | Backend pytest; `npm test`; `tsc`; lint; build | 419 passed, 2 skipped (Kokoro, policy optimizer); 195 passed; exit 0; exit 0; exit 0 (run before the Tailwind fix; rerun on `Y` after it) |
| Live, fresh copy, two keys, browser | Question, wrong answer, label, End session, Mind, Try as Priya, a turn citing her history | All worked. Label 2.6 s; revision 1 with one belief; 22 earlier items used |
| Live, through the web proxy | Real speech (synthesized WAV) to Muse Voice Transcribe | Accurate, 2.9 s |
| Live | Muse Image | Call returned 200; illustration not inspected, it sat behind the question card |
| Live | Every outgoing provider request (test-only log) | 7 of 7 to `api.meta.ai` or `inference.baseten.co` |

The table above fetched the foundation from this folder, before anything was pushed.

### From GitHub, after pushing (2026-11-05)

Clone of `ask-Y` with setup fetching the foundation tag from `Y`, and an env file holding only the two keys.

| Kind | Check | Result |
|---|---|---|
| Setup | `npm run setup` | Exit 0, 40 s with uv and npm caches warm. All 75 foundation files match the tag byte for byte |
| Mocked | Backend pytest; `npm test`; `tsc`; lint; build | 419 passed, 2 skipped; 195 passed; exit 0; exit 0; exit 0. Built CSS holds the board classes |
| Live, browser | Question, wrong typed answer, label 4.1 s (incorrect 0.92, other 0.92), feedback, Trace, End session | Revision 1: an accurate active belief, strength 0.88, and 2 notes |
| Live, browser | Canvases, Review warm-up, Mind, Try as Tomás (revision 7, 32 beliefs) | All worked; no API or web server errors |
| Live, browser | Muse Image | Illustration rendered on the board |
| Live | Every outgoing provider request | 7 of 7 to `api.meta.ai` or `inference.baseten.co` |

### Voice on iPad, and a lesson that never finished (2026-11-05)

**Reported on the deployed site, iPad:** no sound with any voice, Ask stayed red as Stop, and the check card never came.

**Cause (from the code; not reproduced on an iPad).** One bug: a question is drawn only after the voice ends, and `speak()` resolved only on the
browser's end event. iPad Safari allows audio only from a tap, but a lesson speaks later, after the model replies, and it can drop the
speech with no event. Hosted clips failed `play()`, fell back to the browser voice, and hung the same way.

**Fix (`lib/tts.ts`).**
- The end of a tap or a key press starts silent speech and audio, and hosted clips reuse that unlocked element.
- A browser voice that has not started in 3 s is given up on; later lines skip at once until the next tap.
- Time limits on a clip or voice that never starts or never ends. The lesson and the card always continue.
- No cancel right before speaking, device voices preferred over network ones.

**Checks.** Mocked: 8 new tests in `lib/tts.test.ts`. Browser, Chrome on Windows, 2 paid turns: with `speechSynthesis.speak` stubbed to do
nothing, the lesson finished, the card came and Ask returned; with real speech, 2 clips played to their natural end, then the card.
**Not run: an iPad or any Safari.** Whether sound now plays there still needs checking on the device.

**Found, not fixed:** text typed in the composer while a card is open always counts as the answer, though the placeholder says "or ask
something else". A request typed during a warm-up was recorded as the answer. The labeler scored it unanswered at 0.95, so the learner
model was not credited, but the tutor said "You remembered the key idea".

**Not run:** macOS, Linux, a real microphone, heard audio, and real stylus ink. Windows on this laptop needed the SQLAlchemy workaround in
the README. Speech-in was checked only before pushing, with a synthesized clip.

### Non-Meta paths

| Path | Model | Reachable with default settings | Done |
|---|---|---|---|
| `EVIDENCE_LABEL_PROVIDER=openai` | `gpt-6-luna` | No | Kept opt-in |
| `EVIDENCE_LABEL_PROVIDER=baseten` | Elephant | No (403 on these keys anyway) | Kept opt-in |
| `DECISION_PROVIDER`, older Practice assessor | Elephant, or TypeSafe `jev` | **Was yes** on the Practice flow; now no | Default changed to off |
| `voice_router` with `DEEPGRAM_API_KEY` | Deepgram Aura | No | **User decision**: kept, hidden without the key |
| `speech.py` | Kokoro, local open model | No: not installed by setup, left out of the picker | **User decision**: kept |
| `/board/teach`, classic board `model_choice` | Ollama Gemma by default; OpenAI or Google if chosen and keyed | Only from the classic view; fails without Ollama | Left; **user decision** whether to remove |
| `policy_eval` cross-judge | `gpt-6-luna` | Offline only, never the app | Left. H10's gate used the Spark Open judge; the OpenAI score was a cross-check |
| `main.py`, `learner.py`, training, `modal_app.py`, `modal_demo.py`, `modal_train_learner.py` | Ollama, OpenAI, Google | Not in `ask-Y` | Remain in `Y` only |
| `deploy/modal_learning.py` production secret | `EVIDENCE_LABEL_PROVIDER=openai` | Production only | User action, above |

## OpenAI labeler removed; production (2026-11-05)

**Reported:** Trace on the deployed site showed "OpenAI Decisions". **Cause:** it was accurate. Updating the Modal secret does not reach a
running container, and a deploy with no code change keeps it, so production stayed on `gpt-6-luna` after the secret changed.

**Fix:** `OpenAIEvidenceLabeler` is gone from the app, and `EVIDENCE_LABEL_PROVIDER=openai` or a `gpt-` model now gets Muse Spark Open, so an old
secret or `.env` cannot route an answer to OpenAI. Trace no longer has an OpenAI name. Answers labeled earlier keep their true model in Trace,
as `gpt-6-luna`: provenance is not rewritten. The `openai` value stays in the `Observation.labeler` contract so those rows still load.
`gpt-6-luna` remains only in the offline evaluation scripts (`policy_eval`, `eval_learning.py`), never in the app.

**Lesson for production:** after changing a Modal secret, a redeploy alone may not apply it; it needs a code change or a container restart.
