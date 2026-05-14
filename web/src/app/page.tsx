"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Whiteboard, { type WhiteboardHandle } from "@/components/Whiteboard";
import Toolbar from "@/components/Toolbar";
import { fetchHealth, streamLesson } from "@/lib/api";
import { getAnswerRegion, getStudentBbox } from "@/lib/layout";
import { LessonPlayer } from "@/lib/lesson-player";
import { cancelSpeech } from "@/lib/tts";
import type { PrimitiveTag } from "@/lib/types";

interface CachedLesson {
  primitives: PrimitiveTag[];
  origin: { x: number; y: number };
  studentElementCount: number;
}

export default function Home() {
  const handleRef = useRef<WhiteboardHandle | null>(null);
  const [status, setStatus] = useState("Connecting to backend...");
  const [busy, setBusy] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [hasReplay, setHasReplay] = useState(false);
  const cachedRef = useRef<CachedLesson | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHealth().then((h) => {
      if (cancelled) return;
      if (!h) {
        setStatus("Backend unreachable (run: uvicorn main:app)");
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

  const insertSample = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const els = convertToExcalidrawElements([
      {
        type: "text",
        x: 80,
        y: 80,
        text: "F = m * a\nm = 2 kg\nF = 10 N\na = ?",
        fontSize: 28,
        fontFamily: 1,
        strokeColor: "#111",
      },
    ]);
    handle.appendElements(els);
    setStatus("Inserted sample question. Press Solve.");
  }, []);

  const runLesson = useCallback(
    async (mode: "live" | "replay") => {
      const handle = handleRef.current;
      if (!handle || busy) return;
      cancelSpeech();
      setBusy(true);

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
        onProgress: setStatus,
        signal: controller.signal,
      });

      const collect: PrimitiveTag[] = [];

      try {
        if (mode === "live" && liveBlob) {
          await streamLesson(
            liveBlob,
            {
              onPrimitive: (tag) => {
                collect.push(tag);
                player.enqueue(tag);
              },
              onDone: () => setStatus("Lesson received. Finishing playback..."),
              onError: (msg) => setStatus(`Error: ${msg}`),
            },
            controller.signal,
          );
        } else {
          for (const tag of cachedPrims) player.enqueue(tag);
        }
        await player.finish();
        setStatus(
          mode === "live"
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
        abortRef.current = null;
      }
    },
    [busy, ttsEnabled],
  );

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
  }, []);

  return (
    <div className="relative h-dvh w-full">
      <Toolbar
        busy={busy}
        status={status}
        ttsEnabled={ttsEnabled}
        canReplay={hasReplay}
        onSolve={solve}
        onClear={clearAll}
        onInsertSample={insertSample}
        onReplay={replay}
        onStop={stop}
        onToggleTts={() => setTtsEnabled((v) => !v)}
      />
      <Whiteboard onReady={onReady} />
    </div>
  );
}
