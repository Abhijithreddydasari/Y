"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Whiteboard, { type WhiteboardHandle } from "@/components/Whiteboard";
import Toolbar, { type ModelChoice, type SampleSubject } from "@/components/Toolbar";
import EducatorPanel from "@/components/EducatorPanel";
import LearnerPanel from "@/components/LearnerPanel";
import CheckpointCard from "@/components/CheckpointCard";
import { fetchHealth, fetchLearner, resetLearner, streamAssessment, streamLesson } from "@/lib/api";
import { getAnswerRegion, getStudentBbox } from "@/lib/layout";
import { LessonPlayer } from "@/lib/lesson-player";
import { cancelSpeech } from "@/lib/tts";
import type { Checkpoint, EducatorNotes, LearnerSnapshot, LearningEvidence, PrimitiveTag } from "@/lib/types";

interface CachedLesson {
  primitives: PrimitiveTag[];
  origin: { x: number; y: number };
  studentElementCount: number;
}

interface SampleShape {
  type: "ellipse" | "line" | "rectangle" | "diamond";
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
}

interface SampleSpec {
  text: string;
  fontSize?: number;
  // Optional supporting shapes drawn next to the text (relative to text origin
  // 80, 80). Stays hand-drawn so the canvas always looks like a real student
  // started a problem, not a templated form.
  shapes?: SampleShape[];
}

const SAMPLES: Record<SampleSubject, SampleSpec> = {
  math: { text: "right triangle\nlegs 3 and 4\nhypotenuse = ?" },
  physics: {
    text: "block on 30 deg incline\nm = 5 kg\nfrictionless\na = ?",
  },
  chem: { text: "Draw the structure of benzene?\nC6H6\nstructure = ?" },
  bio: {
    text: "Label the parts of an animal cell?",
    shapes: [
      // Outer cell membrane.
      { type: "ellipse", x: 360, y: 60, width: 220, height: 180, strokeWidth: 2 },
      // Nucleus.
      { type: "ellipse", x: 440, y: 110, width: 70, height: 60, strokeWidth: 2 },
    ],
  },
  cs: {
    text: "DFS visit order on this rooted tree?",
    shapes: [
      // Root, two children, four grandchildren — a simple binary-ish tree
      // sketch so the student question has visual context and the model
      // can label nodes 1..7 in DFS order.
      { type: "ellipse", x: 460, y: 60, width: 36, height: 36 }, // A (root)
      { type: "ellipse", x: 410, y: 130, width: 36, height: 36 }, // B
      { type: "ellipse", x: 510, y: 130, width: 36, height: 36 }, // C
      { type: "ellipse", x: 380, y: 200, width: 36, height: 36 }, // D
      { type: "ellipse", x: 440, y: 200, width: 36, height: 36 }, // E
      { type: "ellipse", x: 500, y: 200, width: 36, height: 36 }, // F
      { type: "ellipse", x: 540, y: 200, width: 36, height: 36 }, // G
      { type: "line", x: 478, y: 96, width: -50, height: 34 }, // A->B
      { type: "line", x: 478, y: 96, width: 50, height: 34 },  // A->C
      { type: "line", x: 428, y: 166, width: -30, height: 34 }, // B->D
      { type: "line", x: 428, y: 166, width: 30, height: 34 },  // B->E
      { type: "line", x: 528, y: 166, width: -10, height: 34 }, // C->F
      { type: "line", x: 528, y: 166, width: 30, height: 34 },  // C->G
    ],
  },
};

function getOrCreateUserId(): string {
  if (typeof window === "undefined") return "anon";
  const KEY = "y_user_id";
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id = `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.localStorage.setItem(KEY, id);
  }
  return id;
}

export default function AppPage() {
  const handleRef = useRef<WhiteboardHandle | null>(null);
  const [status, setStatus] = useState("Connecting to backend...");
  const [busy, setBusy] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [voice, setVoice] = useState("kokoro_af_heart");
  const [teacherMode, setTeacherMode] = useState(false);
  const [modelChoice, setModelChoice] = useState<ModelChoice>("edge");
  const [modelReady, setModelReady] = useState<Partial<Record<ModelChoice, boolean>>>({});
  const [hasReplay, setHasReplay] = useState(false);
  const [educatorNotes, setEducatorNotes] = useState<EducatorNotes | null>(null);
  const [educatorBusy, setEducatorBusy] = useState(false);
  const [learnerSnapshot, setLearnerSnapshot] = useState<LearnerSnapshot | null>(null);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [lastEvidence, setLastEvidence] = useState<LearningEvidence | null>(null);
  const cachedRef = useRef<CachedLesson | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const userIdRef = useRef<string>("anon");
  const conversationIdRef = useRef<string>("default");

  const refreshLearner = useCallback(async () => {
    const id = userIdRef.current;
    if (!id || id === "anon") return;
    const snap = await fetchLearner(id);
    if (snap) setLearnerSnapshot(snap);
  }, []);

  useEffect(() => {
    userIdRef.current = getOrCreateUserId();
    const stored = window.sessionStorage.getItem("y_conversation_id");
    conversationIdRef.current = stored || `c_${crypto.randomUUID()}`;
    if (!stored) window.sessionStorage.setItem("y_conversation_id", conversationIdRef.current);
    void refreshLearner();
  }, [refreshLearner]);

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then((h) => {
      if (cancelled) return;
      if (!h) {
        setStatus("Backend unreachable (run: uvicorn main:app)");
        return;
      }
      const ready: Partial<Record<ModelChoice, boolean>> = {};
      for (const [k, v] of Object.entries(h.models ?? {})) {
        ready[k as ModelChoice] = !!v.ready;
      }
      setModelReady(ready);
      if (h.preferred_model === "openai" && ready.openai) {
        setModelChoice("openai");
        setStatus("Ready in GPT-5.6 cloud mode. The canvas will be sent to OpenAI.");
      } else if (!h.ollama_reachable) {
        setStatus(`Ollama unreachable - check daemon (model=${h.model})`);
      } else {
        setStatus(`Ready. Write/draw a question, mark unknown with '?', press Solve.`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onReady = useCallback((handle: WhiteboardHandle) => {
    handleRef.current = handle;
  }, []);

  const clearAll = useCallback(() => {
    handleRef.current?.clearAll();
    cancelSpeech();
    setStatus("Cleared.");
  }, []);

  const insertSample = useCallback(async (subject: SampleSubject) => {
    const handle = handleRef.current;
    if (!handle) return;
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const sample = SAMPLES[subject];
    const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [
      {
        type: "text",
        x: 80,
        y: 80,
        text: sample.text,
        fontSize: sample.fontSize ?? 28,
        fontFamily: 1,
        strokeColor: "#111",
      },
    ];
    for (const s of sample.shapes ?? []) {
      skeletons.push({
        type: s.type,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        strokeColor: s.strokeColor ?? "#111",
        strokeWidth: s.strokeWidth ?? 1.5,
        roughness: s.roughness ?? 1,
      });
    }
    const els = convertToExcalidrawElements(skeletons);
    handle.appendElements(els);
    setStatus(`Inserted ${subject} sample. Press Solve.`);
  }, []);

  const runLesson = useCallback(
    async (mode: "live" | "replay") => {
      const handle = handleRef.current;
      if (!handle || busy) return;
      cancelSpeech();
      setBusy(true);
      setEducatorNotes(null);
      setEducatorBusy(false);

      // Pick the origin: from cache on replay, otherwise from the empty
      // region next to the student's existing drawing.
      let origin: { x: number; y: number };
      let liveBlob: Blob | null = null;
      let cachedPrims: PrimitiveTag[] = [];

      if (mode === "replay") {
        if (!cachedRef.current) {
          setStatus("Nothing to replay yet. Press Solve first.");
          setBusy(false);
          return;
        }
        origin = cachedRef.current.origin;
        cachedPrims = cachedRef.current.primitives;
      } else {
        const studentBbox = getStudentBbox(handle.getElements());
        const region = getAnswerRegion(studentBbox);
        origin = { x: region.x, y: region.y };
        liveBlob = await handle.exportPng();
        if (!liveBlob) {
          setStatus("Canvas export failed.");
          setBusy(false);
          return;
        }
        setStatus(`Sent canvas (${(liveBlob.size / 1024).toFixed(1)} KB) to the model...`);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const player = new LessonPlayer({
        origin,
        handle,
        ttsEnabled,
        voiceName: voice,
        onProgress: setStatus,
        signal: controller.signal,
      });

      const collect: PrimitiveTag[] = [];
      let streamError = "";

      try {
        if (mode === "live" && liveBlob) {
          if (teacherMode) setEducatorBusy(true);
          await streamLesson(
            liveBlob,
            {
              onPrimitive: (tag) => {
                collect.push(tag);
                player.enqueue(tag);
              },
              onEducatorNotes: (notes) => {
                setEducatorNotes(notes);
                setEducatorBusy(false);
              },
              onLearnerUpdate: () => {
                void refreshLearner();
              },
              onLearnerState: () => void refreshLearner(),
              onCheckpoint: (next) => {
                setCheckpoint(next);
                const checkpointTag: PrimitiveTag = {
                  tag: "text",
                  args: { content: `Checkpoint: ${next.question}` },
                };
                collect.push(checkpointTag);
                player.enqueue(checkpointTag);
              },
              onDone: () => setStatus("Lesson received. Finishing playback..."),
              onError: (msg) => {
                streamError = msg;
                setStatus(`Error: ${msg}`);
              },
            },
            controller.signal,
            {
              teacherMode,
              userId: userIdRef.current,
              modelChoice,
              conversationId: conversationIdRef.current,
            },
          );
        } else {
          for (const tag of cachedPrims) player.enqueue(tag);
        }
        await player.finish();
        setStatus(
          streamError
            ? `Error: ${streamError}`
            : mode === "live"
            ? `Lesson complete. ${collect.length} primitives drawn.`
            : `Replay complete.`,
        );
        if (mode === "live" && collect.length) {
          cachedRef.current = {
            primitives: collect,
            origin,
            studentElementCount: handle.getElements().length,
          };
          setHasReplay(true);
        }
      } catch (exc) {
        setStatus(`Stream failed: ${(exc as Error).message}`);
      } finally {
        setBusy(false);
        setEducatorBusy(false);
        abortRef.current = null;
      }
    },
    [busy, ttsEnabled, voice, teacherMode, modelChoice, refreshLearner],
  );

  const assessWork = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle || busy || !checkpoint) return;
    cancelSpeech();
    setBusy(true);
    setStatus("Sending your checkpoint answer for evidence-based assessment...");
    const image = await handle.exportPng();
    if (!image) {
      setStatus("Canvas export failed.");
      setBusy(false);
      return;
    }
    const region = getAnswerRegion(getStudentBbox(handle.getElements()));
    const controller = new AbortController();
    abortRef.current = controller;
    const player = new LessonPlayer({
      origin: { x: region.x, y: region.y },
      handle,
      ttsEnabled,
      voiceName: voice,
      onProgress: setStatus,
      signal: controller.signal,
    });
    let assessmentError = "";
    try {
      await streamAssessment(
        image,
        {
          onPrimitive: (tag) => player.enqueue(tag),
          onEvidence: (evidence) => {
            setLastEvidence(evidence);
            setStatus(evidence.adaptation?.adapted ? "Strong evidence accepted; learner fast weights updated." : "Assessment recorded; adaptation guard kept fast weights unchanged.");
          },
          onLearnerState: () => void refreshLearner(),
          onCheckpoint: (next) => {
            setCheckpoint(next);
            player.enqueue({
              tag: "text",
              args: { content: `Next checkpoint: ${next.question}` },
            });
          },
          onDone: () => setStatus("Assessment received. Finishing personalized feedback..."),
          onError: (message) => {
            assessmentError = message;
            setStatus(`Assessment error: ${message}`);
          },
        },
        controller.signal,
        {
          userId: userIdRef.current,
          conversationId: conversationIdRef.current,
          checkpointId: checkpoint.checkpoint_id,
          modelChoice,
        },
      );
      await player.finish();
      await refreshLearner();
      if (!assessmentError) {
        setStatus("Assessment complete. Try the next checkpoint on the canvas.");
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus(`Assessment failed: ${(error as Error).message}`);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [busy, checkpoint, modelChoice, refreshLearner, ttsEnabled, voice]);

  const onResetLearner = useCallback(async () => {
    const id = userIdRef.current;
    if (!id || id === "anon") return;
    if (!window.confirm("Reset learner profile? This deletes all session memory for this user.")) return;
    await resetLearner(id);
    setLearnerSnapshot(null);
    setCheckpoint(null);
    setLastEvidence(null);
    setStatus("Learner profile reset.");
    void refreshLearner();
  }, [refreshLearner]);

  const solve = useCallback(() => {
    void runLesson("live");
  }, [runLesson]);

  const replay = useCallback(() => {
    void runLesson("replay");
  }, [runLesson]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    cancelSpeech();
    setStatus("Stopped.");
    setBusy(false);
    setEducatorBusy(false);
  }, []);

  return (
    <div className="relative h-dvh w-full">
      <Toolbar
        busy={busy}
        status={status}
        ttsEnabled={ttsEnabled}
        teacherMode={teacherMode}
        modelChoice={modelChoice}
        modelReady={modelReady}
        canReplay={hasReplay}
        canAssess={!!checkpoint}
        voice={voice}
        onSolve={solve}
        onAssess={() => void assessWork()}
        onClear={clearAll}
        onInsertSample={insertSample}
        onReplay={replay}
        onStop={stop}
        onToggleTts={() => setTtsEnabled((v) => !v)}
        onToggleTeacherMode={() => setTeacherMode((v) => !v)}
        onModelChange={setModelChoice}
        onVoiceChange={setVoice}
      />
      <LearnerPanel snapshot={learnerSnapshot} onReset={onResetLearner} />
      <CheckpointCard checkpoint={checkpoint} evidence={lastEvidence} />
      {teacherMode && <EducatorPanel notes={educatorNotes} busy={educatorBusy} />}
      <Whiteboard onReady={onReady} />
    </div>
  );
}
