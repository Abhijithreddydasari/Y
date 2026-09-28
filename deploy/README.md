# Event deployment

The event build keeps deployment concerns in this directory. The public web
app runs on Vercel; the API and the quantized multimodal Gemma teacher run
together on one Modal A10.

## 1. Install the deployment tools

```powershell
python -m pip install -r deploy/requirements-demo.txt
```

## 2. Cache Gemma on Modal

This downloads `gemma4:e4b` once into the `y-event-gemma4` volume:

```powershell
python -m modal run deploy/modal_demo.py::seed_model
```

## 3. Deploy the API

Set the final Vercel origin before deploying so production CORS is exact:

```powershell
$env:Y_DEMO_CORS_ORIGINS="https://your-project.vercel.app"
$env:Y_BUILD_REVISION=(git rev-parse --short HEAD)
$env:Y_DEMO_MIN_CONTAINERS="1"
python -m modal deploy deploy/modal_demo.py
```

Modal prints the API URL. Verify `/health` reports:

- `model_loaded: true`
- `learner_mode: bayesian`
- queue limits enabled
- `edge` ready with `gemma4:e4b`

The deployment keeps one A10 warm and allows one active generation plus twelve
waiting requests. Per browser, the hourly limits are 50 lessons, 50
assessments, and 100 chat prompts. Narration uses the local Kokoro voice and
falls back to browser speech if audio synthesis is temporarily unavailable.

## 4. Deploy the frontend

Use `web/` as the Vercel root and configure:

```text
NEXT_PUBLIC_API_BASE=https://your-modal-api.modal.run
NEXT_PUBLIC_DEMO_MODE=event
```

After the Vercel URL is final, redeploy Modal with that exact origin if it
changed. Test from a phone over cellular data, not only local Wi-Fi.

## 5. Generate event QR codes

```powershell
python deploy/generate_qr.py https://your-project.vercel.app/app
```

This writes an automatic-device QR and a phone-forced QR beside this file.

## 6. Stop at midnight

```powershell
python -m modal app stop y-event-demo
```

The model and learner volumes remain available for a later redeploy. The
training workflow remains separate in `modal_train_learner.py`.
