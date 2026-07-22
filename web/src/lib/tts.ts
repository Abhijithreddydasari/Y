// Backend Kokoro narration with a best-effort browser Speech fallback.
// A speech session can be interrupted to change voice without completing the
// surrounding lesson primitive: synthesis resumes from the next word.

import { API_BASE } from "./api";

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  voiceName?: string;
  onProgress?: (charsSpoken: number) => void;
  /** Already-synthesized clip from the narration look-ahead queue. */
  prepared?: Promise<PreparedSpeech | undefined>;
}

export interface WarmSpeechOptions {
  voiceName?: string;
  rate?: number;
  signal?: AbortSignal;
}

interface SpeechSession {
  cancelled: boolean;
  voiceName: string;
  revision: number;
  controller: AbortController | null;
  audio: HTMLAudioElement | null;
  interrupt: (() => void) | null;
}

interface SegmentResult {
  ended: boolean;
  charsSpoken: number;
}

export interface PreparedSpeech {
  text: string;
  voiceName: string;
  blob: Blob;
}

let activeSession: SpeechSession | null = null;
let preferredVoiceName = "kokoro_af_heart";

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && (
    typeof Audio !== "undefined" || "speechSynthesis" in window
  );
}

/**
 * Change the voice used by the active narration. The current transport is
 * stopped, but the speech session remains alive and resumes at the next word.
 * Returns true when narration was active and a resume was requested.
 */
export function switchSpeechVoice(voiceName: string): boolean {
  preferredVoiceName = voiceName;
  const session = activeSession;
  if (!session || session.cancelled || session.voiceName === voiceName) return false;
  session.voiceName = voiceName;
  session.revision += 1;
  session.controller?.abort();
  session.interrupt?.();
  return true;
}

export function cancelSpeech(): void {
  const session = activeSession;
  activeSession = null;
  if (session) {
    session.cancelled = true;
    session.revision += 1;
    session.controller?.abort();
    session.interrupt?.();
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

/** Synthesize once and retain the WAV so playback does not fetch it again. */
export async function prepareSpeech(
  text: string,
  opts: WarmSpeechOptions = {},
): Promise<PreparedSpeech | undefined> {
  const clean = text.trim().slice(0, 500);
  if (!clean || opts.signal?.aborted) return undefined;
  const voiceName = opts.voiceName ?? preferredVoiceName;
  const response = await fetch(`${API_BASE}/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: clean,
      voice: voiceName,
      speed: Math.max(0.8, Math.min(1.2, opts.rate ?? 1.0)),
    }),
    signal: opts.signal,
  });
  if (!response.ok) throw new Error(`speech warmup returned ${response.status}`);
  return { text: clean, voiceName, blob: await response.blob() };
}

/** Compatibility helper used by callers that only need to warm the cache. */
export async function warmSpeech(
  text: string,
  opts: WarmSpeechOptions = {},
): Promise<void> {
  await prepareSpeech(text, opts);
}

function resumeBoundaryAt(text: string, estimate: number): number {
  let index = Math.max(0, Math.min(text.length, Math.floor(estimate)));
  if (index === 0 || index >= text.length) return index;
  // Avoid restarting halfway through a word. The part already spoken remains
  // visible and the replacement voice starts cleanly at the following word.
  while (index < text.length && !/\s/.test(text[index])) index += 1;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

async function playKokoroSegment(
  session: SpeechSession,
  text: string,
  baseOffset: number,
  opts: SpeakOptions,
): Promise<SegmentResult> {
  const revision = session.revision;
  const requestedVoice = session.voiceName;
  const controller = new AbortController();
  const abortFetch = () => controller.abort();
  session.controller = controller;
  session.interrupt = abortFetch;

  let blob: Blob;
  try {
    const prepared = baseOffset === 0 ? await opts.prepared : undefined;
    if (session.cancelled || revision !== session.revision) {
      return { ended: false, charsSpoken: 0 };
    }
    if (
      prepared
      && prepared.text === text
      && prepared.voiceName === requestedVoice
    ) {
      blob = prepared.blob;
    } else {
      const response = await fetch(`${API_BASE}/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: requestedVoice,
          speed: Math.max(0.8, Math.min(1.2, opts.rate ?? 1.0)),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`speech backend returned ${response.status}`);
      const servedVoice = response.headers.get("X-Speech-Voice");
      if (servedVoice && servedVoice !== requestedVoice) {
        throw new Error(`speech backend returned ${servedVoice} instead of ${requestedVoice}`);
      }
      blob = await response.blob();
    }
  } catch (error) {
    if (session.controller === controller) session.controller = null;
    if (session.interrupt === abortFetch) session.interrupt = null;
    if (controller.signal.aborted || session.cancelled || revision !== session.revision) {
      return { ended: false, charsSpoken: 0 };
    }
    throw error;
  }
  if (session.controller === controller) session.controller = null;
  if (session.interrupt === abortFetch) session.interrupt = null;
  if (session.cancelled || revision !== session.revision) {
    return { ended: false, charsSpoken: 0 };
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  session.audio = audio;

  return new Promise<SegmentResult>((resolve, reject) => {
    let charsSpoken = 0;
    let frame = 0;
    let settled = false;

    const reportProgress = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const ratio = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
      const next = Math.min(text.length, Math.floor(text.length * ratio));
      if (next > charsSpoken) {
        charsSpoken = next;
        opts.onProgress?.(baseOffset + charsSpoken);
      }
    };

    const cleanup = () => {
      if (frame) cancelAnimationFrame(frame);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      if (session.audio === audio) session.audio = null;
      if (session.interrupt === interruptAudio) session.interrupt = null;
    };

    const finish = (ended: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      reportProgress();
      cleanup();
      if (error) reject(error);
      else resolve({ ended, charsSpoken });
    };

    const interruptAudio = () => finish(false);
    const animateProgress = () => {
      if (settled) return;
      reportProgress();
      frame = requestAnimationFrame(animateProgress);
    };
    session.interrupt = interruptAudio;
    audio.onloadedmetadata = () => {
      reportProgress();
      frame = requestAnimationFrame(animateProgress);
    };
    audio.onended = () => {
      charsSpoken = text.length;
      opts.onProgress?.(baseOffset + text.length);
      finish(true);
    };
    audio.onerror = () => {
      if (session.cancelled || revision !== session.revision) finish(false);
      else finish(false, new Error("audio playback failed"));
    };
    void audio.play().catch((error) => {
      if (session.cancelled || revision !== session.revision) finish(false);
      else finish(false, error as Error);
    });
  });
}

async function playBrowserSegment(
  session: SpeechSession,
  text: string,
  baseOffset: number,
  opts: SpeakOptions,
): Promise<SegmentResult> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    opts.onProgress?.(baseOffset + text.length);
    return { ended: true, charsSpoken: text.length };
  }
  const revision = session.revision;
  const voices = await loadBrowserVoices();
  if (session.cancelled || revision !== session.revision) {
    return { ended: false, charsSpoken: 0 };
  }
  return new Promise<SegmentResult>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts.rate ?? 1.0;
    const isMichael = session.voiceName === "kokoro_am_michael";
    utterance.pitch = opts.pitch ?? (isMichael ? 0.82 : 1.08);
    const preferredNames = isMichael
      ? ["guy", "david", "mark", "george", "male"]
      : ["aria", "jenny", "zira", "samantha", "female"];
    const browserVoice = voices.find((voice) => {
      const name = voice.name.toLowerCase();
      return preferredNames.some((candidate) => name.includes(candidate));
    }) ?? voices.find((voice) => voice.lang.toLowerCase().startsWith("en"));
    if (browserVoice) utterance.voice = browserVoice;
    let charsSpoken = 0;
    let settled = false;
    const finish = (ended: boolean) => {
      if (settled) return;
      settled = true;
      if (session.interrupt === interruptBrowser) session.interrupt = null;
      resolve({ ended, charsSpoken });
    };
    const interruptBrowser = () => {
      window.speechSynthesis.cancel();
      finish(false);
    };
    session.interrupt = interruptBrowser;
    utterance.onboundary = (event) => {
      charsSpoken = Math.max(charsSpoken, event.charIndex ?? 0);
      opts.onProgress?.(baseOffset + charsSpoken);
    };
    utterance.onend = () => {
      charsSpoken = text.length;
      opts.onProgress?.(baseOffset + text.length);
      finish(true);
    };
    utterance.onerror = () => finish(
      !session.cancelled && revision === session.revision,
    );
    window.speechSynthesis.speak(utterance);
  });
}

async function loadBrowserVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  const speech = window.speechSynthesis;
  const ready = speech.getVoices();
  if (ready.length > 0) return ready;

  // Chromium loads installed Windows voices asynchronously. Waiting for the
  // catalogue prevents both fallback choices from silently using the same
  // default voice on the first narration.
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      speech.removeEventListener("voiceschanged", finish);
      resolve();
    };
    speech.addEventListener("voiceschanged", finish, { once: true });
    window.setTimeout(finish, 350);
  });
  return speech.getVoices();
}

export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const clean = text.trim().slice(0, 500);
  if (!clean || !ttsAvailable()) return;
  cancelSpeech();
  const requestedVoice = opts.voiceName ?? preferredVoiceName;
  preferredVoiceName = requestedVoice;
  const session: SpeechSession = {
    cancelled: false,
    voiceName: requestedVoice,
    revision: 0,
    controller: null,
    audio: null,
    interrupt: null,
  };
  activeSession = session;
  let cursor = 0;
  let browserFallback = false;

  try {
    while (cursor < clean.length && !session.cancelled) {
      const remaining = clean.slice(cursor);
      let result: SegmentResult;
      try {
        result = browserFallback
          ? await playBrowserSegment(session, remaining, cursor, opts)
          : await playKokoroSegment(session, remaining, cursor, opts);
      } catch {
        if (session.cancelled) return;
        // A backend or media failure is non-blocking. Continue the same
        // unfinished segment through the browser's speech engine.
        browserFallback = true;
        continue;
      }
      if (session.cancelled) return;
      if (result.ended) {
        cursor = clean.length;
      } else {
        const advance = resumeBoundaryAt(remaining, result.charsSpoken);
        cursor += advance;
        opts.onProgress?.(cursor);
      }
    }
  } finally {
    session.controller?.abort();
    session.interrupt?.();
    if (activeSession === session) activeSession = null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
