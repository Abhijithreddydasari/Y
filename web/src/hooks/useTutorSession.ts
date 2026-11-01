"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import type { ModelChoice, SampleSubject } from "@/components/Toolbar";
import { fetchHealth, fetchLearner, resetLearner, streamAssessment, streamChat, streamLesson } from "@/lib/api";
import { lessonContext, primitiveToMarkdown } from "@/lib/chat";
import { getAnswerRegion, getStudentBbox } from "@/lib/layout";
import { LessonPlayer } from "@/lib/lesson-player";
import { applyLearnerSnapshot, applyLearnerState } from "@/lib/learner-state";
import { cancelSpeech } from "@/lib/tts";
import type { ChatMessage, Checkpoint, EducatorNotes, LearnerSnapshot, LearningEvidence, PrimitiveTag } from "@/lib/types";
import { streamBoardTeach, type ContextRequest, type Packet } from "@/lib/board-api";

interface CachedLesson {
  primitives: PrimitiveTag[];
  origin: { x: number; y: number };
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
  shapes?: SampleShape[];
}

const SAMPLES: Record<SampleSubject, SampleSpec> = {
  math: { text: "right triangle\nlegs 3 and 4\nhypotenuse = ?" },
  physics: { text: "block on 30 deg incline\nm = 5 kg\nfrictionless\na = ?" },
  chem: { text: "Draw the structure of benzene?\nC6H6\nstructure = ?" },
  bio: {
    text: "Label the parts of an animal cell?",
    shapes: [
      { type: "ellipse", x: 360, y: 60, width: 220, height: 180, strokeWidth: 2 },
      { type: "ellipse", x: 440, y: 110, width: 70, height: 60, strokeWidth: 2 },
    ],
  },
  cs: {
    text: "DFS visit order on this rooted tree?",
    shapes: [
      { type: "ellipse", x: 460, y: 60, width: 36, height: 36 },
      { type: "ellipse", x: 410, y: 130, width: 36, height: 36 },
      { type: "ellipse", x: 510, y: 130, width: 36, height: 36 },
      { type: "ellipse", x: 380, y: 200, width: 36, height: 36 },
      { type: "ellipse", x: 440, y: 200, width: 36, height: 36 },
      { type: "ellipse", x: 500, y: 200, width: 36, height: 36 },
      { type: "ellipse", x: 540, y: 200, width: 36, height: 36 },
      { type: "line", x: 478, y: 96, width: -50, height: 34 },
      { type: "line", x: 478, y: 96, width: 50, height: 34 },
      { type: "line", x: 428, y: 166, width: -30, height: 34 },
      { type: "line", x: 428, y: 166, width: 30, height: 34 },
      { type: "line", x: 528, y: 166, width: -10, height: 34 },
      { type: "line", x: 528, y: 166, width: 30, height: 34 },
    ],
  },
};

function getOrCreateUserId(): string {
  const key = "y_user_id";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = `u_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.localStorage.setItem(key, id);
  }
  return id;
}

export interface TutorSession {
  status: string;
  busy: boolean;
  narrating: boolean;
  ttsEnabled: boolean;
  voice: string;
  teacherMode: boolean;
  modelChoice: ModelChoice;
  modelReady: Partial<Record<ModelChoice, boolean>>;
  hasReplay: boolean;
  educatorNotes: EducatorNotes | null;
  educatorBusy: boolean;
  learnerSnapshot: LearnerSnapshot | null;
  checkpoint: Checkpoint | null;
  lastEvidence: LearningEvidence | null;
  chatMessages: ChatMessage[];
  chatBusy: boolean;
  sttAvailable: boolean;
  sttModel: string;
  onWhiteboardReady: (handle: WhiteboardHandle) => void;
  solve: () => void;
  assess: () => void;
  replay: () => void;
  stop: () => void;
  clearBoard: () => void;
  insertSample: (subject: SampleSubject) => Promise<void>;
  toggleTts: () => void;
  toggleTeacherMode: () => void;
  changeModel: (model: ModelChoice) => void;
  changeVoice: (voice: string) => void;
  resetLearner: () => Promise<void>;
  sendChatMessage: (text: string) => Promise<void>;
  cancelChat: () => void;
  clearChat: () => void;
}

export function useTutorSession(): TutorSession {
  const handleRef = useRef<WhiteboardHandle | null>(null);
  const [status, setStatus] = useState("Connecting to your tutor…");
  const [busy, setBusy] = useState(false);
  const [narrating, setNarrating] = useState(false);
  // Narration is part of the event demo's core loop. The backend Kokoro voice
  // is preferred when available, while tts.ts falls back to browser speech.
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [voice, setVoice] = useState("kokoro_af_heart");
  const voiceRef = useRef("kokoro_af_heart");
  const [teacherMode, setTeacherMode] = useState(false);
  const [modelChoice, setModelChoice] = useState<ModelChoice>("edge");
  const [modelReady, setModelReady] = useState<Partial<Record<ModelChoice, boolean>>>({});
  const [hasReplay, setHasReplay] = useState(false);
  const [educatorNotes, setEducatorNotes] = useState<EducatorNotes | null>(null);
  const [educatorBusy, setEducatorBusy] = useState(false);
  const [learnerSnapshot, setLearnerSnapshot] = useState<LearnerSnapshot | null>(null);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [lastEvidence, setLastEvidence] = useState<LearningEvidence | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [sttAvailable, setSttAvailable] = useState(false);
  const [sttModel, setSttModel] = useState("moonshine-tiny-en");
  const cachedRef = useRef<CachedLesson | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const playerRef = useRef<LessonPlayer | null>(null);
  const userIdRef = useRef("anon");
  const conversationIdRef = useRef("default");

  const refreshLearner = useCallback(async () => {
    const id = userIdRef.current;
    if (!id || id === "anon") return;
    const snapshot = await fetchLearner(id);
    if (snapshot) setLearnerSnapshot((current) => applyLearnerSnapshot(current, snapshot));
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
    void fetchHealth().then((health) => {
      if (cancelled) return;
      if (!health) {
        setStatus("The tutor is offline. Check the connection and try again.");
        return;
      }
      const ready: Partial<Record<ModelChoice, boolean>> = {};
      for (const [key, value] of Object.entries(health.models ?? {})) ready[key as ModelChoice] = Boolean(value.ready);
      setModelReady(ready);
      setSttAvailable(Boolean(health.transcription?.available));
      setSttModel(health.transcription?.model ?? "moonshine-tiny-en");
      if (process.env.NEXT_PUBLIC_DEMO_MODE === "event") {
        setModelChoice("edge");
        setStatus(ready.edge ? "Ready. Draw a question or try a sample." : "The hosted tutor is warming up…");
      } else if (health.preferred_model === "openai" && ready.openai) {
        setModelChoice("openai");
        setStatus("Ready in cloud mode. Draw a question or try a sample.");
      } else if (!health.ollama_reachable) {
        setStatus("The local tutor is offline. Start Ollama and try again.");
      } else {
        setStatus("Ready. Draw a question or try a sample.");
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    chatAbortRef.current?.abort();
    playerRef.current?.cancel();
    cancelSpeech();
  }, []);

  const onWhiteboardReady = useCallback((handle: WhiteboardHandle) => { handleRef.current = handle; }, []);

  const beginTranscript = useCallback((source: "lesson" | "assessment") => {
    const id = `${source}_${crypto.randomUUID()}`;
    const message: ChatMessage = { id, role: "assistant", content: "", source, pending: true };
    setChatMessages((current) => [...current, message].slice(-40));
    return id;
  }, []);

  const appendTranscriptPrimitive = useCallback((id: string, tag: PrimitiveTag) => {
    const markdown = primitiveToMarkdown(tag);
    if (!markdown) return;
    setChatMessages((current) => current.map((message) => message.id === id
      ? { ...message, content: message.content ? `${message.content}\n\n${markdown}` : markdown }
      : message));
  }, []);

  const finishTranscript = useCallback((id: string) => {
    setChatMessages((current) => current
      .map((message) => message.id === id ? { ...message, pending: false } : message)
      .filter((message) => message.id !== id || Boolean(message.content)));
  }, []);

  const clearBoard = useCallback(() => {
    handleRef.current?.clearAll();
    cancelSpeech();
    setCheckpoint(null);
    setLastEvidence(null);
    setStatus("Board cleared. Draw a question or try a sample.");
  }, []);

  const insertSample = useCallback(async (subject: SampleSubject) => {
    const handle = handleRef.current;
    if (!handle) return;
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const sample = SAMPLES[subject];
    const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [{
      type: "text", x: 80, y: 80, text: sample.text, fontSize: sample.fontSize ?? 28,
      fontFamily: 1, strokeColor: "#111",
    }];
    for (const shape of sample.shapes ?? []) {
      skeletons.push({
        type: shape.type, x: shape.x, y: shape.y, width: shape.width, height: shape.height,
        strokeColor: shape.strokeColor ?? "#111", strokeWidth: shape.strokeWidth ?? 1.5,
        roughness: shape.roughness ?? 1,
      });
    }
    handle.clearAll("system");
    handle.appendElements(convertToExcalidrawElements(skeletons), "system");
    setCheckpoint(null);
    setLastEvidence(null);
    setStatus(`${subject[0].toUpperCase()}${subject.slice(1)} sample ready. Tap Teach me.`);
  }, []);

  const runLesson = useCallback(async (mode: "live" | "replay") => {
    const handle = handleRef.current;
    if (!handle || busy) return;
    playerRef.current?.cancel();
    cancelSpeech();
    setBusy(true);
    setEducatorNotes(null);
    setEducatorBusy(false);
    let origin: { x: number; y: number };
    let liveBlob: Blob | null = null;
    let cachedPrimitives: PrimitiveTag[] = [];
    let prepared: { request: ContextRequest; packet: Packet } | null = null;
    if (mode === "replay") {
      if (!cachedRef.current) {
        setStatus("There is no lesson to replay yet.");
        setBusy(false);
        return;
      }
      origin = cachedRef.current.origin;
      cachedPrimitives = cachedRef.current.primitives;
    } else {
      try {
        if (handle.board) {
          setStatus("Saving relevant board context…");
          prepared = await handle.board.prepare(undefined, true);
          handle.board.generationSource = prepared.packet.source;
          handle.board.generationArea = prepared.packet.response_area;
          origin = prepared.packet.response_area;
        } else {
          const region = getAnswerRegion(getStudentBbox(handle.getElements()));
          origin = { x: region.x, y: region.y };
          liveBlob = await handle.exportPng();
          if (!liveBlob) throw new Error("I could not read the board. Add a question and try again.");
        }
      } catch (error) { setStatus((error as Error).message); setBusy(false); return; }
      setStatus("Reading your board…");
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const player = new LessonPlayer({
      origin, handle, ttsEnabled, voiceName: voiceRef.current, onProgress: setStatus,
      onNarratingChange: setNarrating, signal: controller.signal,
      validateSource: prepared ? () => Boolean(handle.board?.validSource(prepared!.packet.source)) : undefined,
    });
    playerRef.current = player;
    if (prepared && handle.board) handle.board.onStaleSource = () => {
      controller.abort(); player.cancel(); setStatus("Your question changed. Ask again using the updated board.");
    };
    const collected: PrimitiveTag[] = [];
    const transcriptId = mode === "live" ? beginTranscript("lesson") : "";
    let streamError = "";
    let generationFinish: Promise<void> | null = null;
    try {
      if (mode === "live" && prepared && handle.board) {
        await streamBoardTeach(handle.board.session, prepared.request, modelChoice, (event, value) => {
          if (!handle.board?.validSource(prepared!.packet.source)) { controller.abort(); player.cancel(); throw new Error("Your question changed. Ask again using the updated board."); }
          if (event === "primitive") {
            const tag = value as PrimitiveTag;
            collected.push(tag); player.enqueue(tag); appendTranscriptPrimitive(transcriptId, tag);
          }
          if (event === "status") setStatus((value as { text: string }).text);
        }, controller.signal);
      } else if (mode === "live" && liveBlob) {
        if (teacherMode) setEducatorBusy(true);
        await streamLesson(liveBlob, {
          onPrimitive: (tag) => { collected.push(tag); player.enqueue(tag); appendTranscriptPrimitive(transcriptId, tag); },
          onGenerationComplete: () => {
            generationFinish ??= player.finishDrawing().then(() => setStatus("Lesson ready. Building your learning profile…"));
          },
          onEducatorNotes: (notes) => { setEducatorNotes(notes); setEducatorBusy(false); },
          onLearnerState: (state) => setLearnerSnapshot((current) => applyLearnerState(current, state, userIdRef.current)),
          // Ignore checkpoint events from older backends during rollout.
          onDone: () => setStatus("Finishing your lesson…"),
          onError: (message) => { streamError = message; setStatus(`The lesson stopped: ${message}`); },
        }, controller.signal, {
          teacherMode, userId: userIdRef.current, modelChoice, conversationId: conversationIdRef.current,
        });
        if (generationFinish) await generationFinish;
      } else {
        for (const tag of cachedPrimitives) player.enqueue(tag);
      }
      await player.finishDrawing();
      if (handle.board) await handle.board.flush();
      setStatus(streamError ? `The lesson stopped: ${streamError}` : mode === "live"
        ? "Lesson ready. Ask a follow-up in chat or try another question." : "Replay complete.");
      if (mode === "live" && collected.length) {
        cachedRef.current = { primitives: collected, origin };
        setHasReplay(true);
      }
      void player.finishNarration().finally(() => {
        if (playerRef.current === player) playerRef.current = null;
        setNarrating(false);
      });
    } catch (error) {
      if (!controller.signal.aborted) setStatus(`The lesson failed: ${(error as Error).message}`);
    } finally {
      if (transcriptId) finishTranscript(transcriptId);
      setBusy(false);
      setEducatorBusy(false);
      abortRef.current = null;
    }
  }, [appendTranscriptPrimitive, beginTranscript, busy, finishTranscript, modelChoice, teacherMode, ttsEnabled]);

  const assess = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle || busy || !checkpoint) return;
    playerRef.current?.cancel();
    cancelSpeech();
    setBusy(true);
    setStatus("Checking your answer…");
    const image = await handle.exportPng();
    if (!image) {
      setStatus("I could not read the answer. Add it to the board and try again.");
      setBusy(false);
      return;
    }
    const region = getAnswerRegion(getStudentBbox(handle.getElements()));
    const controller = new AbortController();
    abortRef.current = controller;
    const player = new LessonPlayer({
      origin: { x: region.x, y: region.y }, handle, ttsEnabled, voiceName: voiceRef.current,
      onProgress: setStatus, onNarratingChange: setNarrating, signal: controller.signal,
    });
    playerRef.current = player;
    let assessmentError = "";
    const transcriptId = beginTranscript("assessment");
    try {
      await streamAssessment(image, {
        onPrimitive: (tag) => { player.enqueue(tag); appendTranscriptPrimitive(transcriptId, tag); },
        onEvidence: (evidence) => { setLastEvidence(evidence); setStatus("Evidence recorded. Updating your learning profile…"); },
        onLearnerState: (state) => setLearnerSnapshot((current) => applyLearnerState(current, state, userIdRef.current)),
        onCheckpoint: (next) => {
          setCheckpoint(next);
          const tag: PrimitiveTag = { tag: "text", args: { content: `Next checkpoint: ${next.question}` } };
          player.enqueue(tag); appendTranscriptPrimitive(transcriptId, tag);
        },
        onDone: () => setStatus("Finishing personalized feedback…"),
        onError: (message) => { assessmentError = message; setStatus(`The assessment stopped: ${message}`); },
      }, controller.signal, {
        userId: userIdRef.current, conversationId: conversationIdRef.current,
        checkpointId: checkpoint.checkpoint_id, modelChoice,
      });
      await player.finishDrawing();
      if (!assessmentError) setStatus("Assessment complete. Try the next checkpoint.");
      void player.finishNarration().finally(() => {
        if (playerRef.current === player) playerRef.current = null;
        setNarrating(false);
      });
    } catch (error) {
      if (!controller.signal.aborted) setStatus(`The assessment failed: ${(error as Error).message}`);
    } finally {
      finishTranscript(transcriptId);
      abortRef.current = null;
      setBusy(false);
    }
  }, [appendTranscriptPrimitive, beginTranscript, busy, checkpoint, finishTranscript, modelChoice, ttsEnabled]);

  const sendChatMessage = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || chatBusy || busy) return;
    const userMessage: ChatMessage = { id: `user_${crypto.randomUUID()}`, role: "user", content: clean, source: "chat" };
    const replyId = `chat_${crypto.randomUUID()}`;
    const reply: ChatMessage = { id: replyId, role: "assistant", content: "", source: "chat", pending: true };
    const history = [...chatMessages.filter((message) => !message.pending), userMessage].slice(-40);
    setChatMessages([...history, reply]);
    setChatBusy(true);
    const controller = new AbortController();
    chatAbortRef.current = controller;
    let streamError = "";
    try {
      await streamChat({
        messages: history, userId: userIdRef.current, conversationId: conversationIdRef.current,
        modelChoice, lessonContext: lessonContext(history),
      }, {
        onDelta: (delta) => setChatMessages((current) => current.map((message) =>
          message.id === replyId ? { ...message, content: message.content + delta } : message)),
        onError: (message) => {
          streamError = message;
          setChatMessages((current) => current.map((item) => item.id === replyId
            ? { ...item, content: item.content || message, error: true, pending: false } : item));
        },
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        streamError = (error as Error).message;
        setChatMessages((current) => current.map((item) => item.id === replyId
          ? { ...item, content: streamError, error: true, pending: false } : item));
      }
    } finally {
      setChatMessages((current) => current
        .map((message) => message.id === replyId ? { ...message, pending: false } : message)
        .filter((message) => message.id !== replyId || Boolean(message.content) || Boolean(streamError)));
      if (chatAbortRef.current === controller) chatAbortRef.current = null;
      setChatBusy(false);
    }
  }, [busy, chatBusy, chatMessages, modelChoice]);

  const cancelChat = useCallback(() => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatMessages((current) => current.map((message) => message.pending
      ? { ...message, pending: false, content: message.content || "Response stopped." } : message));
    setChatBusy(false);
  }, []);

  const clearChat = useCallback(() => { cancelChat(); setChatMessages([]); }, [cancelChat]);

  const resetLearnerProfile = useCallback(async () => {
    const id = userIdRef.current;
    if (!id || id === "anon") return;
    if (!window.confirm("Reset your learning profile and all evidence?")) return;
    await resetLearner(id);
    setLearnerSnapshot(null); setCheckpoint(null); setLastEvidence(null);
    setStatus("Learning profile reset.");
    void refreshLearner();
  }, [refreshLearner]);

  const changeVoice = useCallback((nextVoice: string) => {
    voiceRef.current = nextVoice;
    setVoice(nextVoice);
    const resumed = playerRef.current?.setVoice(nextVoice) ?? false;
    const label = nextVoice === "kokoro_am_michael" ? "Michael" : "Heart";
    setStatus(resumed ? `Switching to ${label}…` : `Narration voice set to ${label}.`);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort(); playerRef.current?.cancel(); cancelSpeech();
    setStatus("Stopped. Your board is unchanged."); setBusy(false); setEducatorBusy(false);
  }, []);

  return {
    status, busy, narrating, ttsEnabled, voice, teacherMode, modelChoice, modelReady,
    hasReplay, educatorNotes, educatorBusy, learnerSnapshot, checkpoint, lastEvidence,
    chatMessages, chatBusy, sttAvailable, sttModel, onWhiteboardReady,
    solve: () => { void runLesson("live"); },
    assess: () => { void assess(); },
    replay: () => { void runLesson("replay"); },
    stop, clearBoard, insertSample,
    toggleTts: () => setTtsEnabled((value) => !value),
    toggleTeacherMode: () => setTeacherMode((value) => !value),
    changeModel: setModelChoice, changeVoice, resetLearner: resetLearnerProfile,
    sendChatMessage, cancelChat, clearChat,
  };
}
