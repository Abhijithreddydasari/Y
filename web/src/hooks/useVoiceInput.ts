"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { boardSession } from "@/lib/board-api";
import { transcribe, voiceErrorMessage, warmTranscription } from "@/lib/voice-input";
import { RecorderError, startWavRecording, type WavRecording } from "@/lib/wav-recorder";

export type VoiceState = "idle" | "starting" | "recording" | "transcribing";
export interface VoiceInput {
  state: VoiceState;
  /** Seconds recorded so far, while recording. */
  seconds: number;
  error: string;
  /** The learner blocked the microphone or there is none; typing is the only input until reload. */
  blocked: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  /** Drop the last voice notice (the learner moved on by typing). */
  clearError: () => void;
  /** Live input loudness, 0 to 1, while recording (read per animation frame, not state). */
  level: () => number;
}

export const MAX_RECORDING_MS = 30_000;
const MIN_RECORDING_MS = 400;

/** One recording → one transcript. `onText` receives it; failures leave typing untouched. */
export function useVoiceInput(onText: (text: string) => void, onStart?: () => void): VoiceInput {
  const [state, setState] = useState<VoiceState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const recordingRef = useRef<WavRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef<VoiceState>("idle");
  const textRef = useRef(onText);
  useEffect(() => { textRef.current = onText; }, [onText]);
  const move = (next: VoiceState) => { stateRef.current = next; setState(next); };

  const stop = useCallback(() => {
    const recording = recordingRef.current;
    if (stateRef.current !== "recording" || !recording) return;
    recordingRef.current = null;
    const elapsed = recording.elapsedMs();
    move("transcribing");
    void (async () => {
      const ended = performance.now();
      const audio = await recording.stop();
      if (elapsed < MIN_RECORDING_MS) {
        setError("Hold the mic while you speak, or tap once to start and again to send.");
        move("idle");
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await transcribe(await boardSession(), audio, controller.signal);
        console.debug("[voice] timing", JSON.stringify({ audio_ms: Math.round(elapsed), stop_to_text_ms: Math.round(performance.now() - ended),
          ...result.timing }));
        move("idle");
        textRef.current(result.text);
      } catch (failure) {
        if (!controller.signal.aborted) setError(voiceErrorMessage(failure));
        move("idle");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();
  }, []);

  const start = useCallback(() => {
    if (stateRef.current !== "idle" || blocked) return;
    setError(""); setSeconds(0);
    move("starting");
    onStart?.();
    void (async () => {
      try {
        const recording = await startWavRecording({ maxMs: MAX_RECORDING_MS, onLimit: stop });
        if (stateRef.current !== "starting") { await recording.cancel(); return; }
        recordingRef.current = recording;
        move("recording");
        void boardSession().then(warmTranscription).catch(() => {});
      } catch (failure) {
        const reason = failure instanceof RecorderError ? failure.reason : "failed";
        if (reason !== "failed") setBlocked(true);
        setError(reason === "denied" ? "Microphone blocked: type instead."
          : reason === "unavailable" ? "No microphone found: type instead." : "The microphone could not start. Type instead.");
        move("idle");
      }
    })();
  }, [blocked, onStart, stop]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) void recording.cancel();
    move("idle");
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => setSeconds(Math.floor((recordingRef.current?.elapsedMs() ?? 0) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => () => { abortRef.current?.abort(); void recordingRef.current?.cancel(); }, []);

  const clearError = useCallback(() => setError(""), []);
  const level = useCallback(() => recordingRef.current?.level() ?? 0, []);

  return { state, seconds, error, blocked, start, stop, cancel, clearError, level };
}
