# Third-party notices

This file records the principal model, data, and runtime assets used by Y v2.
It is not a substitute for the complete license texts distributed by each
upstream project. The machine-readable dependency inventory is
`sbom.spdx.json` and can be regenerated with
`api/.venv/Scripts/python.exe api/scripts/generate_sbom.py`.

## Speech

- **Moonshine Voice 0.0.69** — MIT-licensed runtime and native English G2P.
  Source: <https://github.com/moonshine-ai/moonshine>. Y does not call or ship
  eSpeak. Only the English G2P dependencies requested by Moonshine are cached.
- **Kokoro-82M v1.0** — Apache-2.0 model weights. Source:
  <https://huggingface.co/hexgrad/Kokoro-82M>. Upstream model SHA-256:
  `496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4`.
- **Kokoro voices `af_heart` and `am_michael`** — the only voice assets Y
  permits. Voice and ONNX assets are downloaded lazily by Moonshine and should
  be locked for a release with `api/scripts/prefetch_speech.py`.
- English G2P lexicon/model sources are documented by Moonshine under
  `core/moonshine-tts/data/`, including CMUdict and English Wiktionary notices.

The runtime asset audit rejects file paths containing `piper`, `zipvoice`, or
`espeak`. No Piper voice, voice-cloning reference, GPL phonemizer, or eSpeak
binary is included in this repository. Set `SPEECH_REQUIRE_LOCK=1` after
generating `api/speech_assets.lock.json` to make hash verification mandatory.

## Learner-adapter datasets

- **GSM8K** — MIT License. Source: <https://github.com/openai/grade-school-math>.
- **OpenBookQA** — Apache License 2.0. Source:
  <https://github.com/allenai/OpenBookQA>.
- **ASSISTments** is optional research-only input under its own data terms. It
  is not downloaded, redistributed, or required by the commercial checkpoint.

Synthetic trajectories generated from the two permissive item banks contain
simulated learner state, not real student records. Dataset manifests include
source names, licenses, random seeds, and content hashes.

## Application libraries

Python and JavaScript dependencies, resolved versions, and archive hashes are
listed in `api/uv.lock`, `web/package-lock.json`, and `sbom.spdx.json`.
