# Y web app

Next.js frontend for Y, the Gemma-powered whiteboard tutor.

The app has two routes:

* `/` - landing page.
* `/app` - Excalidraw learning canvas.

## Run locally

Start the FastAPI backend first from the repo root, then run:

```cmd
cd /d "C:\path\to\Y\web"
npm install --legacy-peer-deps
npm run dev
```

Open `http://localhost:3000/app`.

## Main pieces

* `src/app/app/page.tsx` orchestrates the lesson flow.
* `src/components/Whiteboard.tsx` wraps Excalidraw and exposes canvas helpers.
* `src/components/Toolbar.tsx` contains Solve, Replay, samples, TTS, teacher mode, and model selection.
* `src/components/LearnerPanel.tsx` renders the learner-space visualization.
* `src/lib/api.ts` sends the canvas PNG to `/lesson` and parses SSE events.
* `src/lib/renderer.ts` converts primitives into Excalidraw elements.
* `src/lib/lesson-player.ts` plays primitives sequentially with narration.
