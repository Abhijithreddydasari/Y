# Y: a whiteboard tutor that learns how you think

Ask Y anything by typing or speaking. It teaches on a shared whiteboard, checks your understanding, and keeps a model of what you
know and which wrong beliefs you hold. The next lesson starts from that model, and you can open it, in **Mind**, to see why.

Built for the Meta Global AI Developer Hackathon. Every model call uses a Meta model.

## Run it

You need [Node 20+](https://nodejs.org/), [git](https://git-scm.com/downloads) and [uv](https://docs.astral.sh/uv/getting-started/installation/)
(uv installs a supported Python if you need one). Commands are the same on Windows, macOS and Linux.

```bash
git clone https://github.com/Abhijithreddydasari/ask-Y.git
cd ask-Y
npm run setup
```

Put your two keys in the new `.env` file:

```text
MODEL_API_KEY=your Meta key
BASETEN_API_KEY=your Baseten key
```

Start the API and the web app in two terminals:

```bash
npm run api
```

```bash
npm run dev
```

Open <http://localhost:3000/app>. No other key or setting is needed.

## Try this

1. Ask a question, for example "why does attention use a softmax?". Y draws the lesson and asks you something.
2. Answer it wrongly on purpose, in words.
3. Press **End session**. Y seals what it learned about you.
4. Open **Mind** to see the belief it recorded and the answers behind it, and **Trace** to see each model call and its latency.
5. Ask about the same topic again. The new lesson starts from what you got wrong.

To skip straight to a learner with weeks of history, open **Settings → Try as…** and pick Priya, Tomás or Amara.
Each is a private copy, labelled as seeded, built through the real capture and close path.

## What existed before, and what was built this week

Y began before the event, in the public repository [Abhijithreddydasari/Y](https://github.com/Abhijithreddydasari/Y).
**This repository holds only work from the event**: every file here was created during it, and the commits are the original ones
with their original dates.

`npm run setup` fetches the older code from that repository, at the exact commit pinned in [`foundation.json`](foundation.json), and
lays it in beside this code. Those files are git-ignored here. They are the older board and client shell (`Whiteboard`,
`renderer`, `tts`, `useTutorSession`, the Studio and Mobile shells), some server helpers and the project configuration.

Some of those files needed changes this week. The pin has two commits so you can see exactly which:

- `kept_files_commit`: the older files, unchanged from before the event.
- `commit`: the same files with this week's edits. Diff the two to read every one of them.

**Built this week:** the Muse Spark tutor turn and its streaming board moves, voice input, board artifacts and widgets, evidence capture
and labeling, the learner model and misconception ledger, Mind, the study loop, Review and Trace, personas, and the policy evaluation.

## Meta models used

| Job | Model | Key |
|---|---|---|
| Live tutor | Muse Spark 1.3 (picker also offers 1.2 and Muse Spark Open) | `MODEL_API_KEY` |
| Speech to text | Muse Voice Transcribe | `MODEL_API_KEY` |
| Board illustrations | Muse Image | `MODEL_API_KEY` |
| Evidence labels, including handwriting crops | Muse Spark Open | `BASETEN_API_KEY` |
| Session-close notes and belief names | Muse Spark Open | `BASETEN_API_KEY` |

Narration uses your browser's built-in voice, so no text-to-speech model runs by default.

Accuracy and its limits are in [the labeler report](docs/reports/meta-labeler.md). How the pieces fit together is in
[`docs/handoffs/`](docs/handoffs/), one file per slice.

## Checks

```bash
npm test
npm run lint
npm run build
```

```bash
cd api
uv run python -m pytest -q tests
```

Tests are mocked and make no paid calls. Live checks are separate and paid: `api/policy_eval/label_check.py` and `ink_check.py`.

## Troubleshooting

- **The page loads but questions fail.** Check that `npm run api` is still running on port 8101, and that both keys are set in `.env`.
  Restart the API after changing `.env`.
- **Windows blocks a SQLAlchemy DLL when the API starts** (Application Control). Reinstall it without compiled extensions, in CMD
  from `api`, then start the API with `npm run api`:

  ```bat
  set DISABLE_SQLALCHEMY_CEXT=1
  uv pip install --python .venv\Scripts\python.exe --reinstall --no-binary sqlalchemy "sqlalchemy==2.1.6" "typing-extensions==4.15.0"
  ```

- **No sound.** Your browser or system may have no speech voice installed. Lessons still draw, with captions.

MIT license. Y is an educational prototype, and its judgments of your answers can be wrong.
