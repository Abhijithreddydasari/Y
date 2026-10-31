# Hackathon contribution log

Baseline inspected on October 29, 2026: `e14fe5e820d7785d60bb5aa024a80ca5cbf6f38c`.

The repository already contained an Excalidraw whiteboard, teacher providers, chat/speech, and a legacy learner adapter. This baseline is recorded for attribution; it does not establish event eligibility for reused code. Confirm the Indie track's reuse policy separately.

New work on `feature/session-learning-capture`:

- Subject-independent capture contracts, reference topic packs, numerical verifier registry, and official Jev adapter.
- Transactional evidence storage, anonymous ownership, duplicate/lease recovery, and shared assessment budgets.
- A Practice panel in the existing whiteboard, same-origin credential proxy, source receipts, and explicit uncertainty.
- CPU-only service/deployment entrypoint, provider preflight, and configuration documentation.
- Offline policy-evaluation boundary and unreviewed seed fixtures for later GEPA work.
- Backend/frontend regression and failure-path tests.

This work does not include a live provider accuracy result, deployed service, trained model, GEPA optimization run, or measured retention improvement. No PR has been opened.

October 30 follow-up:

- Added hosted Baseten Elephant, Mammoth, and Joey selection using the same evidence contracts. Elephant is the default; TypeSafe Jev remains explicitly selectable. Mutable model aliases are marked in observations.
- Hardened wire JSON validation against duplicate keys, nonfinite values, excessive nesting, and invalid Unicode that could prevent persistence.
- Preserved retry allowance and provider budgets when credentials are missing, with recovery of the same attempt after configuration.
- Added 28 mocked-provider and API recovery tests. Live accuracy, latency, and credit eligibility still need verification after credentials are configured.
