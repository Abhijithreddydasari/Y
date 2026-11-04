# Meta-only and local handoff

Branch `feature/meta-only-local`, cut from `main` at `543d991`. Not pushed, not deployed.

## Part 1: Meta evidence labeler (done)

Default labeler is now Muse Spark Open at `reasoning_effort=minimal`, on `BASETEN_API_KEY`, with no setting needed. The wiring is
kept: `EVIDENCE_LABEL_PROVIDER` also takes `meta` (Muse Spark on `MODEL_API_KEY`), and `openai` and `baseten` stay opt-in. No
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

## Part 2: runs locally on two keys

Not started. Findings so far, unverified until a fresh clone runs:

- `uv sync` installs `torch` although `learning.app` does not import it.
- The web proxy defaults to port 8000 while the docs run the API on 8101.
- `README.md` still describes Ollama.
- `DECISION_PROVIDER` defaults to Elephant for the older assessor on the classic Practice panel.
