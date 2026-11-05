"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import type { ModelChoice, SampleSubject } from "@/components/Toolbar";
import { fetchHealth, fetchLearner, resetLearner, streamAssessment, streamChat, streamLesson } from "@/lib/api";
import { legacyApiConfigured } from "@/lib/legacy-api";
import { lessonContext, primitiveToMarkdown } from "@/lib/chat";
import { getAnswerRegion, getStudentBbox } from "@/lib/layout";
import { LessonPlayer } from "@/lib/lesson-player";
import { cardNote } from "@/lib/renderer";
import { applyLearnerSnapshot, applyLearnerState } from "@/lib/learner-state";
import { cancelSpeech, installSpeechUnlock } from "@/lib/tts";
import type { ChatMessage, Checkpoint, EducatorNotes, LearnerSnapshot, LearningEvidence, PrimitiveTag } from "@/lib/types";
import { boardSession, startNextBoardSession, streamBoardTeach, type ContextRequest, type Packet } from "@/lib/board-api";
import { belowCard, drawPoint } from "@/lib/board-pointing";
import { BOARD_QUESTION, cardId, closeSession, fetchReview, fetchSessionStatus, fetchTutorState, moveToPrimitive, pointId, questionOf, requestHint,
  setSessionMemory, streamTutorTurn, tutorErrorMessage, type CloseSummary, type Hint, type ReviewItem, type TurnBody,
  type TurnMemory, type TutorQuestion, type TutorTimeline, composerAnswer } from "@/lib/tutor-turn";
import { pendingImages, watchImage } from "@/lib/board-images";
import { fetchTutorOptions, KOKORO_VOICES, loadPrefs, resolvePrefs, savePrefs, type TutorOptions, type TutorPrefs,
  type TutorTrace } from "@/lib/tutor-options";

/** `via` records how the learner answered, for evidence; omitted means tap for a choice and typed for text. */
export interface TutorAnswer { choice?: string; text?: string; confidence: number | null; reveal?: boolean; via?: "spoken" | "typed" }
export interface TutorTurnState {
  /** null until the server reports whether a tutor key is configured. */
  configured: boolean | null;
  busy: boolean;
  draft: string;
  question: TutorQuestion | null;
  caption: string;
  error: string;
  timing: TutorTimeline | null;
  /** The voice is still talking through a drawn turn; Stop stays available. */
  narrating: boolean;
  setDraft: (text: string) => void;
  ask: (text: string) => void;
  answer: (value: TutorAnswer) => void;
  cardRect: (qid: string) => DOMRect | null;
  revealCard: (qid: string) => void;
  /** Silence the narration only (the learner started talking). */
  hush: () => void;
  picker: { options: TutorOptions | null; prefs: TutorPrefs; trace: TutorTrace | null; setModel: (id: string) => void;
    setVoice: (id: string) => void };
  /** Memory on: turns read the brief compiled from earlier sessions. Off: the generic tutor (for comparison). */
  memory: { on: boolean; set: (on: boolean) => void; turn: TurnMemory | null };
  /** End session: offers the exit ticket first when the session has answered checks, otherwise seals at once. */
  endSession: () => void;
  ending: boolean;
  /** Which mind End session saves to: null is the board's own (the profile it was opened in). */
  saveTo: { value: SaveTarget | null; set: (target: SaveTarget | null) => void };
  /** Warm-up reviews due from earlier sessions; never blocks asking. `visible` is false once skipped or asked past. */
  warmup: { items: ReviewItem[]; visible: boolean; started: boolean; start: () => void; skip: () => void };
  /** The exit-ticket offer shown after End session: take it, or end straight away. */
  exit: { offered: boolean; take: () => void; skip: () => void };
  /** Hint ladder on the open card: 1 nudge, 2 worked step; the third rung is "Just tell me". */
  hints: { given: Hint[]; busy: boolean; next: () => void };
  /** This canvas was sealed at an earlier End session: it can be viewed, and asking needs a new session. */
  sealed: boolean;
  newSession: () => void;
}

const LAST_CLOSE = "y_last_close";

/** Another of this browser's minds: "own", or a demo persona key, with the name shown when it is saved. */
export interface SaveTarget { into: string; name: string }

export function closeMessage(summary: CloseSummary, mind?: string): string {
  if (!summary.profile_updated) return "Session ended. No answered checks to learn from, so your profile is unchanged.";
  const parts = [`${summary.sealed} answer${summary.sealed === 1 ? "" : "s"} sealed`];
  if (summary.misconceptions?.length) parts.push(`${summary.misconceptions.length} misconception${summary.misconceptions.length === 1 ? "" : "s"} noted`);
  if (summary.notes?.length) parts.push(`${summary.notes.length} teaching note${summary.notes.length === 1 ? "" : "s"}`);
  const kept = mind ?? (summary.persona ? `${summary.persona.split(" ")[0]}'s mind` : "your profile");
  return `Session saved to ${kept} (revision ${summary.revision}): ${parts.join(", ")}. This is a new session.`;
}

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
  tutor: TutorTurnState;
}

export function useTutorSession(): TutorSession {
  const handleRef = useRef<WhiteboardHandle | null>(null);
  const [status, setStatus] = useState("Connecting to your tutor…");
  const [busy, setBusy] = useState(false);
  const [narrating, setNarrating] = useState(false);
  // Narration is part of the event demo's core loop. The backend Kokoro voice
  // is preferred when available, while tts.ts falls back to browser speech.
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const ttsRef = useRef(true);
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
  const [tutorConfigured, setTutorConfigured] = useState<boolean | null>(null);
  const [tutorBusy, setTutorBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState<TutorQuestion | null>(null);
  const [caption, setCaption] = useState("");
  const [tutorError, setTutorError] = useState("");
  const [timing, setTiming] = useState<TutorTimeline | null>(null);
  const tutorAbortRef = useRef<AbortController | null>(null);
  const tutorKnownRef = useRef(false);
  const [tutorOptions, setTutorOptions] = useState<TutorOptions | null>(null);
  const [prefs, setPrefs] = useState<TutorPrefs>({ model: "spark-1.3", voice: "browser" });
  const prefsRef = useRef(prefs);
  // What unmuting returns to: the last voice chosen, whichever kind it was.
  const lastVoiceRef = useRef(prefs.voice);
  const [trace, setTrace] = useState<TutorTrace | null>(null);
  const [memoryOn, setMemoryOn] = useState(true);
  const [turnMemory, setTurnMemory] = useState<TurnMemory | null>(null);
  const [ending, setEnding] = useState(false);
  const [saveTo, setSaveTo] = useState<SaveTarget | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [warmupOpen, setWarmupOpen] = useState(true);
  const [warmupStarted, setWarmupStarted] = useState(false);
  const [exitOffered, setExitOffered] = useState(false);
  // Hints fetched for one card; each card starts its own ladder, and a restored card brings the hints already given.
  const [fetchedHints, setFetchedHints] = useState<{ qid: string; hints: Hint[] } | null>(null);
  const hints = (fetchedHints && fetchedHints.qid === question?.qid ? fetchedHints.hints : question?.hints) ?? [];
  const [hintBusy, setHintBusy] = useState(false);
  const [sealed, setSealed] = useState(false);
  // Answered checks this session (an exit ticket is offered only after some) and whether one was taken.
  const answeredRef = useRef(0);
  const exitTakenRef = useRef(false);

  const refreshLearner = useCallback(async () => {
    const id = userIdRef.current;
    if (!id || id === "anon" || !legacyApiConfigured()) return;
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
    // Legacy model health speaks only until the tutor service has reported its own state.
    const legacyStatus = (text: string) => { if (!tutorKnownRef.current) setStatus(text); };
    if (!legacyApiConfigured()) return;
    void fetchHealth().then((health) => {
      if (cancelled) return;
      if (!health) {
        legacyStatus("The tutor is offline. Check the connection and try again.");
        return;
      }
      const ready: Partial<Record<ModelChoice, boolean>> = {};
      for (const [key, value] of Object.entries(health.models ?? {})) ready[key as ModelChoice] = Boolean(value.ready);
      setModelReady(ready);
      setSttAvailable(Boolean(health.transcription?.available));
      setSttModel(health.transcription?.model ?? "moonshine-tiny-en");
      if (process.env.NEXT_PUBLIC_DEMO_MODE === "event") {
        setModelChoice("edge");
        legacyStatus(ready.edge ? "Ready. Draw a question or try a sample." : "The hosted tutor is warming up…");
      } else if (health.preferred_model === "openai" && ready.openai) {
        setModelChoice("openai");
        legacyStatus("Ready in cloud mode. Draw a question or try a sample.");
      } else if (!health.ollama_reachable) {
        legacyStatus("The local tutor is offline. Start Ollama and try again.");
      } else {
        legacyStatus("Ready. Draw a question or try a sample.");
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Restore the waiting state after a refresh; the board itself is restored by the board controller.
  useEffect(() => {
    let cancelled = false;
    void boardSession().then(fetchTutorState).then((state) => {
      if (cancelled) return;
      tutorKnownRef.current = true;
      setTutorConfigured(state.configured);
      setQuestion(state.open);
      answeredRef.current = state.turns.filter((t) => t.kind === "answer").length;
      exitTakenRef.current = state.turns.some((t) => t.kind === "exit");
      // The warm-up belongs to the start of a session: once the learner has asked something, it stays out of the way.
      if (state.turns.some((t) => t.kind === "question")) setWarmupOpen(false);
      const said = state.turns.at(-1)?.said.at(-1);
      if (said) setCaption(said);
      let closed: string | null = null;
      try { closed = sessionStorage.getItem(LAST_CLOSE); sessionStorage.removeItem(LAST_CLOSE); } catch { /* storage blocked */ }
      if (!state.configured) setStatus("The tutor is not configured on the server (MODEL_API_KEY is missing).");
      else if (closed) setStatus(closed);
      else setStatus(state.open ? "Your turn: answer the card on the board." : "Ready. Ask a question about anything on the board.");
    }).catch((error) => { if (!cancelled) setTutorError(tutorErrorMessage(error)); });
    void boardSession().then(fetchSessionStatus).then(({ memory, status }) => {
      if (cancelled) return;
      setMemoryOn(memory);
      if (status === "closed") { setSealed(true); setStatus("This canvas is sealed. You can look around; start a new session to ask."); }
      else void boardSession().then(fetchReview).then((items) => { if (!cancelled) setReviews(items); }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    tutorAbortRef.current?.abort();
    abortRef.current?.abort();
    chatAbortRef.current?.abort();
    playerRef.current?.cancel();
    cancelSpeech();
  }, []);

  const onWhiteboardReady = useCallback((handle: WhiteboardHandle) => {
    handleRef.current = handle;
    // Illustrations still painting when the page was closed: pick their jobs up again.
    const session = handle.board?.session;
    if (session) for (const id of pendingImages(handle)) void watchImage(handle, session, id);
  }, []);

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

  const runTurn = useCallback(async (body: Omit<TurnBody, "board">, onAccepted?: () => void): Promise<boolean> => {
    const handle = handleRef.current, board = handle?.board;
    if (!handle || !board?.ready || tutorBusy || busy) {
      setTutorError(board?.ready === false ? "Wait until the board has restored." : "");
      return false;
    }
    playerRef.current?.cancel();
    cancelSpeech();
    setTutorBusy(true); setTutorError(""); setCaption("");
    setStatus("Saving your board…");
    const controller = new AbortController();
    tutorAbortRef.current = controller;
    const started = performance.now();
    const stages: TutorTimeline = {};
    let asked: TutorQuestion | null = null, accepted = false, moved = false, turnId = body.turn_id;
    const previous = question;
    try {
      const prepared = await board.prepare(undefined, true, false);
      stages.prepare_ms = performance.now() - started;
      const view = prepared.request.viewport;
      // Feedback goes under the answered card when that space is free; a blank board starts inside the view;
      // otherwise the builder's area beside the work.
      const beside = body.kind === "answer" && body.question_id ? belowCard(handle.getElements(), cardId(body.question_id)) : null;
      const origin = beside ?? (prepared.packet.focused.length ? prepared.packet.response_area : { x: view.x + Math.min(120, view.w * 0.1), y: view.y + 100 });
      // The board is written at board speed; each segment's `say` is spoken once its visuals are drawn.
      const player = new LessonPlayer({ origin, handle, ttsEnabled: true, voiceName: voiceRef.current, onNarratingChange: setNarrating,
        browserOnly: prefsRef.current.voice === "browser",
        signal: controller.signal, pacing: "segment", visualGapMs: 150, onCaption: setCaption,
        onRendered: () => { stages.first_render_ms ??= performance.now() - started; },
        onAudible: ({ engine, waitMs }) => {
          stages.first_audio_ms ??= performance.now() - started;
          console.debug("[tutor] audible", JSON.stringify({ engine, wait_ms: Math.round(waitMs) }));
        } });
      player.setMuted(!ttsRef.current);
      playerRef.current = player;
      setStatus("Thinking…");
      const model = tutorOptions ? { model: prefsRef.current.model } : {};
      await streamTutorTurn(board.session, { ...body, ...model, board: prepared.request }, {
        onTurn: (value) => { turnId = value.turn_id; accepted = true; if (body.kind === "question") setDraft(""); else setQuestion(null); onAccepted?.(); },
        onMove: (move, index) => {
          stages.first_move_ms ??= performance.now() - started;
          moved = true;
          if (move.type === "say") { player.say(move.text); return; }
          // A ring on the learner's own ink, drawn in stream order before the explanation that follows it.
          if (move.type === "point") { player.enqueueStep(() => drawPoint(handle, move, pointId(turnId, index))); return; }
          if (move.type === "seg") player.beginSegment();
          asked = questionOf(move) ?? asked;
          const tag = moveToPrimitive(move);
          if (tag) player.enqueue(tag);
          // Painted in the background; the placeholder is swapped once the image is ready.
          if (move.type === "image" && move.image_id) void watchImage(handle, board.session, move.image_id);
          setStatus("Explaining…");
        },
        onDone: (value) => { asked = value.question ?? asked; if (value.tutor) setTrace(value.tutor); if (value.memory) setTurnMemory(value.memory); Object.assign(stages, Object.fromEntries(Object.entries(value.timing ?? {}).map(([k, v]) => [`server_${k}`, v]))); },
      }, controller.signal);
      await player.finishDrawing();
      stages.drawn_ms = performance.now() - started;
      void player.finishNarration().then(() => console.debug("[tutor] narrated", JSON.stringify({
        narrated_ms: Math.round(performance.now() - started), first_audio_ms: stages.first_audio_ms && Math.round(stages.first_audio_ms) })));
      await board.flush().catch(() => {});
      setQuestion(asked);
      // Stop after the stream ended skips queued drawing; the server already holds the full turn.
      setStatus(controller.signal.aborted ? "Stopped. What was drawn is kept."
        : asked ? "Your turn: answer the card on the board." : "Done. Ask a follow-up any time.");
      return true;
    } catch (error) {
      // A drawn question stays answerable after Stop or a late failure, matching the server's record.
      // A turn that drew nothing leaves the earlier question open, as the server does.
      if (accepted) setQuestion(moved ? asked : previous);
      if (controller.signal.aborted) setStatus("Stopped. What was drawn is kept.");
      else {
        const message = tutorErrorMessage(error);
        setTutorError(message); setStatus(message);
        if (error instanceof Error && "code" in error && error.code === "tutor_not_configured") setTutorConfigured(false);
      }
      return accepted;
    } finally {
      stages.total_ms = performance.now() - started;
      setTiming(stages);
      console.debug("[tutor] timing", JSON.stringify(stages));
      if (tutorAbortRef.current === controller) tutorAbortRef.current = null;
      setTutorBusy(false);
    }
  }, [busy, question, tutorBusy, tutorOptions]);

  useEffect(() => installSpeechUnlock(), []);

  const closeNow = useCallback(() => {
    setEnding(true); setTutorError(""); setExitOffered(false);
    setStatus("Saving this session to your learner profile…");
    void boardSession().then((session) => closeSession(session, saveTo?.into)).then((summary) => {
      const message = closeMessage(summary, saveTo?.name);
      try { sessionStorage.setItem(LAST_CLOSE, message); } catch { /* the status is shown once anyway */ }
      startNextBoardSession();
      window.location.reload();
    }).catch((error) => {
      const message = tutorErrorMessage(error);
      setTutorError(message); setStatus(message); setEnding(false);
    });
  }, [saveTo]);

  const answer = useCallback((value: TutorAnswer) => {
    if (!question) return;
    const exitTicket = question.origin === "exit";
    const handle = handleRef.current, label = value.reveal ? "You asked to be told." : `You answered: ${value.choice ?? value.text ?? ""}`
      + (value.confidence === null ? "" : ` (${value.confidence}% sure)`);
    void runTurn({ turn_id: crypto.randomUUID(), kind: "answer", question_id: question.qid, choice: value.choice,
      text: value.text, confidence: value.confidence, reveal: value.reveal, ...(value.via ? { via: value.via } : {}) }, () => {
      answeredRef.current += 1;
      // Record the answer on the card itself; the server keeps the learner's input as the source of truth.
      const frame = handle?.getElements().find((e) => e.id === cardId(question.qid));
      const text = handle?.getElements().find((e) => e.id === `${cardId(question.qid)}-text`);
      if (!handle || !frame || !text || text.type !== "text") return;
      const note = cardNote(label), extra = note.extra, next = `${text.text}\n\n${note.text}`;
      // Cosmetic only: Excalidraw's dev build throws on some older boards' fractional indices, which
      // must never abort the feedback turn (the answer is already recorded).
      try {
        handle.mutateElement(text.id, { text: next, originalText: next, height: text.height + extra });
        handle.mutateElement(frame.id, { height: frame.height + extra });
      } catch (error) {
        console.warn("could not mark the answered card", error);
      }
    }).then((accepted) => {
      // The exit ticket flows into the close once its one-line feedback has been drawn.
      if (exitTicket && accepted) closeNow();
    });
  }, [closeNow, question, runTurn]);

  const ask = useCallback((text: string) => {
    let clean = text.trim();
    if (!clean) {
      // Ask with an empty box answers what the learner wrote on the board; a blank board makes no call.
      const records = handleRef.current?.board?.state?.records ?? {};
      const learnerWork = (handleRef.current?.getElements() ?? []).some((e) => !e.isDeleted && (records[e.id] ? records[e.id].creator === "human" : true));
      if (!learnerWork) { setTutorError("Write or draw your question on the board, or type it here."); return; }
      clean = BOARD_QUESTION;
    }
    // An answer typed into the composer while a card waits is evidence for that card, not a new question.
    const typed = question && composerAnswer(question, clean);
    if (typed) { setDraft(""); answer({ ...typed, confidence: null, via: "typed" }); return; }
    setDraft(clean);
    setWarmupOpen(false);
    void runTurn({ turn_id: crypto.randomUUID(), kind: "question", text: clean });
  }, [answer, question, runTurn]);

  const startReview = useCallback(() => {
    const item = reviews[0];
    if (!item) return;
    setWarmupStarted(true);
    void runTurn({ turn_id: crypto.randomUUID(), kind: "review", concept: item.concept }).then((accepted) => {
      if (accepted) setReviews((current) => current.filter((r) => r.concept !== item.concept));
    });
  }, [reviews, runTurn]);

  const takeExit = useCallback(() => {
    setExitOffered(false);
    exitTakenRef.current = true;
    void runTurn({ turn_id: crypto.randomUUID(), kind: "exit" }).then((accepted) => {
      // No card came back (provider failure): offer the plain close so End session is never a dead end.
      if (!accepted) setExitOffered(true);
    });
  }, [runTurn]);

  const nextHint = useCallback(() => {
    if (!question || hintBusy) return;
    const level = hints.length + 1;
    if (level > 2) { answer({ reveal: true, confidence: null }); return; }
    setHintBusy(true); setTutorError("");
    const qid = question.qid;
    void boardSession().then((session) => requestHint(session, qid, level)).then((given) => setFetchedHints({ qid, hints: given }))
      .catch((error) => setTutorError(tutorErrorMessage(error))).finally(() => setHintBusy(false));
  }, [answer, hintBusy, hints.length, question]);

  const setMemory = useCallback((on: boolean) => {
    setMemoryOn(on);
    void boardSession().then((session) => setSessionMemory(session, on)).then(setMemoryOn).catch((error) => {
      setMemoryOn(!on); setTutorError(tutorErrorMessage(error));
    });
  }, []);

  const endSession = useCallback(() => {
    if (ending || tutorBusy) return;
    // One short check on the session's main idea first, when there is something to check; never required.
    if (answeredRef.current > 0 && !exitTakenRef.current && !exitOffered) {
      setExitOffered(true);
      setStatus("One quick check before you go?");
      return;
    }
    closeNow();
  }, [closeNow, ending, exitOffered, tutorBusy]);

  const newSession = useCallback(() => { startNextBoardSession(); window.location.reload(); }, []);

  const cardRect = useCallback((qid: string) => handleRef.current?.getElementScreenRect(cardId(qid)) ?? null, []);
  const revealCard = useCallback((qid: string) => { handleRef.current?.revealElement(cardId(qid)); }, []);

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

  const toggleTts = useCallback(() => {
    ttsRef.current = !ttsRef.current;
    setTtsEnabled(ttsRef.current);
    playerRef.current?.setMuted(!ttsRef.current);
    // Keep the picker truthful: muting is "Off"; unmuting returns to the last voice chosen.
    const voice = ttsRef.current ? lastVoiceRef.current : "off";
    if (ttsRef.current) playerRef.current?.setBrowserOnly(voice === "browser");
    prefsRef.current = { ...prefsRef.current, voice };
    setPrefs(prefsRef.current);
    savePrefs(prefsRef.current);
  }, []);

  const hush = useCallback(() => { playerRef.current?.cancel(); cancelSpeech(); }, []);

  // Voice choice: a Kokoro voice, the browser voice, or off (the same switch as the Narration toggle).
  const applyVoice = useCallback((id: string) => {
    const on = id !== "off";
    if (on) lastVoiceRef.current = id;
    ttsRef.current = on;
    setTtsEnabled(on);
    playerRef.current?.setMuted(!on);
    playerRef.current?.setBrowserOnly(id === "browser");
    if (KOKORO_VOICES.has(id) && id !== voiceRef.current) { voiceRef.current = id; setVoice(id); playerRef.current?.setVoice(id); }
  }, []);

  const choose = useCallback((change: Partial<TutorPrefs>) => {
    const next = { ...prefsRef.current, ...change };
    prefsRef.current = next;
    setPrefs(next);
    savePrefs(next);
    if (change.voice) applyVoice(change.voice);
  }, [applyVoice]);

  useEffect(() => {
    let cancelled = false;
    void fetchTutorOptions().then((options) => {
      if (cancelled || !options) return;
      const next = resolvePrefs(options, loadPrefs());
      prefsRef.current = next;
      setTutorOptions(options); setPrefs(next); applyVoice(next.voice);
    });
    return () => { cancelled = true; };
  }, [applyVoice]);

  const stop = useCallback(() => {
    const tutorRunning = Boolean(tutorAbortRef.current) || narrating;
    tutorAbortRef.current?.abort(); abortRef.current?.abort(); playerRef.current?.cancel(); cancelSpeech();
    setStatus(tutorRunning ? "Stopped. What was drawn is kept." : "Stopped. Your board is unchanged."); setBusy(false); setEducatorBusy(false);
  }, [narrating]);

  return {
    status, busy: busy || tutorBusy, narrating, ttsEnabled, voice, teacherMode, modelChoice, modelReady,
    hasReplay, educatorNotes, educatorBusy, learnerSnapshot, checkpoint, lastEvidence,
    chatMessages, chatBusy, sttAvailable, sttModel, onWhiteboardReady,
    solve: () => { void runLesson("live"); },
    assess: () => { void assess(); },
    replay: () => { void runLesson("replay"); },
    stop, clearBoard, insertSample,
    toggleTts,
    toggleTeacherMode: () => setTeacherMode((value) => !value),
    changeModel: setModelChoice, changeVoice, resetLearner: resetLearnerProfile,
    sendChatMessage, cancelChat, clearChat,
    tutor: { configured: tutorConfigured, busy: tutorBusy, draft, question, caption, error: tutorError, timing, narrating,
      setDraft, ask, answer, cardRect, revealCard, hush,
      picker: { options: tutorOptions, prefs, trace, setModel: (model) => choose({ model }), setVoice: (voice) => choose({ voice }) },
      memory: { on: memoryOn, set: setMemory, turn: turnMemory }, endSession, ending,
      saveTo: { value: saveTo, set: setSaveTo },
      warmup: { items: reviews, visible: warmupOpen && !sealed && reviews.length > 0, started: warmupStarted, start: startReview,
        skip: () => setWarmupOpen(false) },
      exit: { offered: exitOffered, take: takeExit, skip: closeNow },
      hints: { given: hints, busy: hintBusy, next: nextHint }, sealed, newSession },
  };
}
