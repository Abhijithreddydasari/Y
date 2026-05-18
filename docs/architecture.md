# Architecture

## High-level

```mermaid
flowchart LR
    subgraph Browser
        EX[Excalidraw canvas<br/>+ student sketch]
        TB[Toolbar · model selector]
        LP[LearnerPanel<br/>UMAP 3D]
        EP[EducatorPanel<br/>Teacher Mode]
        PLR[LessonPlayer<br/>stroke anim + TTS]
    end

    subgraph FastAPI[FastAPI · /lesson]
        TEA[Teacher Protocol]
        TEA --> EDG[OllamaTeacher<br/>gemma4:e4b]
        TEA --> EFT[OllamaTeacher<br/>y-gemma4 LoRA]
        TEA --> CLD[CloudTeacher<br/>gemma-4-31b-it]
        PAR[IncrementalTagParser<br/>block-aware]
        VAL[validate_and_repair<br/>repair + salvage]
        LRN[learner.py<br/>extract + embed + persist]
    end

    subgraph Storage
        JSON[(per-user<br/>learner JSON)]
    end

    EX -->|PNG| TEA
    TB -.model_choice.-> TEA
    EDG -->|tokens| PAR
    EFT -->|tokens| PAR
    CLD -->|tokens| PAR
    PAR -->|primitive| VAL
    VAL -->|SSE event| PLR
    PLR -->|render| EX
    PAR -->|lesson_text| LRN
    LRN <-->|read/write| JSON
    LRN -->|mastery_summary| TEA
    LRN -->|learner_update SSE| LP
    VAL -->|lesson_text| EP
    PAR -->|done| EP
    TEA -->|educator_notes call| EP
```

## Lesson stream lifecycle

```mermaid
sequenceDiagram
    participant Student
    participant Browser
    participant API
    participant Teacher
    participant Parser
    participant Validator
    participant Player

    Student->>Browser: draws question + ?
    Browser->>API: POST /lesson (PNG, model_choice, user_id)
    API->>Teacher: stream_lesson(png, mastery_prefix)
    loop tokens
        Teacher-->>Parser: token
        Parser->>Validator: primitive candidate
        Validator-->>Browser: SSE primitive (repaired)
        Browser->>Player: enqueue
        Player-->>Student: draw stroke + speak (lock-stepped)
    end
    Teacher-->>API: done
    opt Teacher Mode on
        API->>Teacher: educator_notes(png, lesson_text)
        Teacher-->>API: JSON
        API-->>Browser: SSE educator_notes
        Browser->>Browser: render EducatorPanel
    end
    API->>API: learner.py extract+embed
    API-->>Browser: SSE learner_update
    Browser->>Browser: refresh LearnerPanel UMAP
```

## File layout (textual)

```
Y/
├─ web/src/                   Next.js 16 / React 19 / Excalidraw
│  ├─ app/page.tsx            orchestrator: state, runLesson, modelChoice
│  ├─ components/
│  │  ├─ Whiteboard.tsx       Excalidraw wrapper + appendElements helper
│  │  ├─ Toolbar.tsx          model picker, Solve, Replay, Stop, samples
│  │  ├─ EducatorPanel.tsx    teacher-mode notes, bottom-right
│  │  └─ LearnerPanel.tsx     3D UMAP knowledge map, bottom-left
│  └─ lib/
│     ├─ api.ts               streamLesson SSE client + fetchHealth/Learner
│     ├─ renderer.ts          primitive → Excalidraw element
│     ├─ rough-svg.ts         experimental hand-drawn pass on raw SVG
│     ├─ lesson-player.ts     queue + TTS sync + sequential playback
│     ├─ katex.ts             [equation] → SVG
│     ├─ tts.ts               Web Speech API wrapper
│     ├─ layout.ts            studentBbox + answerRegion math
│     └─ types.ts             primitive + lesson event types
├─ api/                       FastAPI + Ollama + Cloud teacher
│  ├─ main.py                 /health · /schema · /lesson · /learner
│  ├─ teacher.py              Teacher protocol · OllamaTeacher · CloudTeacher · MODEL_REGISTRY
│  ├─ parser.py               incremental tag state machine + bare-header repair
│  ├─ validator.py            schema check · aliases · equation auto-promotion
│  ├─ salvage.py              JSON/OCR/plain-text fallback to primitives
│  ├─ learner.py              concept extraction · nomic embed · JSON store
│  ├─ prompts/
│  │  ├─ system.md            multi-tool agent prompt
│  │  ├─ primitives.md        tag-by-tag reference
│  │  └─ examples/            newton / vector_sum / binary_search
│  └─ scripts/                test_parser.py · test_teacher.py · smoke_demos.py
├─ schema/primitives.json     single source of truth
├─ training/
│  ├─ prepare_dataset.py      ControlSketch-Part → instruction JSONL
│  ├─ _build_notebook.py      generator
│  └─ unsloth-training.ipynb  QLoRA on gemma-4-E4B-it
├─ models/
│  ├─ Modelfile.y-gemma4      Ollama wrapper for the fine-tuned GGUF
│  └─ README.md
├─ deploy/
│  ├─ modal_app.py            serverless API on Modal (cloud-only)
│  └─ README.md
└─ docs/
   ├─ kaggle_writeup.md       judge-facing pitch
   ├─ architecture.md         this file
   └─ video_script.md         3-minute video shoot script
```

## Why this layout

* **Schema as a contract.** `schema/primitives.json` is loaded by both
  the validator (Python) and the renderer (TypeScript). Adding a new
  primitive means editing one file and getting both sides in sync.
* **Teacher protocol.** `Teacher` is a `typing.Protocol` so the
  registry can switch between local and cloud without the rest of the
  API knowing or caring.
* **Streaming all the way down.** Tokens, primitives, educator notes,
  learner updates — every event is an SSE frame. The frontend never
  does request-response polling.
* **One source of truth per concern.** Prompts live with the API
  (because they're tied to the model). Demo samples live with the
  frontend (because they're tied to UI). Dataset prep lives in
  `training/` (because it produces an artifact the model consumes).
