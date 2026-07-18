# Deploying Y v2

## Submission demo: local UI/API + GPT-5.6

Run FastAPI and Next.js on the demo laptop, set `OPENAI_API_KEY`, and keep
Ollama running for the privacy-fallback segment. Install `api[speech]` and
prefetch the locked Kokoro assets before recording. A CUDA-enabled PyTorch
build plus `ADAPTER_DEVICE=cuda` is recommended for the online-update latency
target.

## Public judge URL: Modal API + Vercel frontend

```powershell
modal secret create y-openai OPENAI_API_KEY=sk-...
modal secret create y-google-ai GOOGLE_API_KEY=... CLOUD_MODEL=gemma-4-31b-it
modal deploy deploy/modal_app.py
```

Set the returned URL as `NEXT_PUBLIC_API_BASE` in Vercel. Mounting the
`y-learner` Modal volume preserves learner JSON and fast weights across cold
starts. For a public education demo, use a disposable judge user and document
that the canvas is sent to OpenAI in cloud mode.

## Training the global adapter on Modal

```powershell
modal secret create y-openai OPENAI_API_KEY=sk-...
modal run deploy/modal_train_learner.py --learners 4000 --turns 48
```

The A10G job builds the licensed synthetic corpus, trains with early stopping,
and writes checkpoint/config/manifest hashes to the `y-learner-training`
volume. Download `learner-adapter-v1.safetensors` into `models/` before the
final benchmark and demo.

## Post-deploy checks

- `/health` reports OpenAI ready, `trained_checkpoint: true`, the expected
  adapter device, and speech readiness.
- Run a help request: online steps must remain unchanged.
- Submit one strong checkpoint: online steps should increase by three.
- Reset the judge user and confirm JSON plus fast weights disappear.
- Confirm the toolbar visibly labels GPT-5.6 as cloud mode.
