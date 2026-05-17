# Deploying Y

Three valid topologies; pick one based on what you want judges to see.

## 1. Local-only (recommended for the demo video)

Run everything on the laptop with the GPU:

```bash
ollama serve                                    # daemon, port 11434
ollama pull gemma4:e4b
ollama pull nomic-embed-text
# optional: build the fine-tuned tag
ollama create y-gemma4 -f ../models/Modelfile.y-gemma4

cd ../api && uv sync && uv run uvicorn main:app --port 8000

cd ../web && npm i --legacy-peer-deps && npm run dev
```

Open http://localhost:3000 . Toolbar dropdown will show all three model
options as `ready`.

## 2. Cloud-only public URL (Modal + Vercel)

Use this if you want a live link for judges. Skip the GPU, drive Gemma 4
31B over Google AI Studio.

```bash
pip install modal
modal token new
modal secret create y-google-ai \
    --from-literal GOOGLE_API_KEY=<your-key> \
    --from-literal CLOUD_MODEL=gemma-4-31b-it
modal deploy modal_app.py
```

Modal prints a `https://<user>--y-api-fastapi-app.modal.run` URL.

```bash
cd ../web
vercel link
vercel env add NEXT_PUBLIC_API_BASE production
# paste the Modal URL when prompted
vercel --prod
```

In this mode the toolbar greys out the Edge / Edge-fine-tuned options; the
Cloud option works.

## 3. Hybrid (local edge GPU + Vercel frontend)

For when you want to demo edge inference but share a polished URL:

* `ngrok http 8000` to expose the local FastAPI.
* Set `NEXT_PUBLIC_API_BASE` on Vercel to the ngrok URL.
* Keep `ollama serve` running locally.

# Smoke testing

After any deploy:

```bash
cd api && .\.venv\Scripts\python.exe scripts\smoke_demos.py --base https://<modal-url> --all-models
```

Prints a 5-subject x 3-model matrix of primitive counts and latencies.
