// Backend Kokoro narration with a best-effort browser Speech fallback.
// The active fetch and audio element are both cancellable so Stop is immediate.

import { API_BASE } from "./api";

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  voiceName?: string;
  onProgress?: (charsSpoken: number) => void;
}

let activeController: AbortController | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeResolve: (() => void) | null = null;

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && (
    typeof Audio !== "undefined" || "speechSynthesis" in window
  );
}

export function cancelSpeech(): void {
  activeController?.abort();
  activeController = null;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.removeAttribute("src");
    activeAudio.load();
    activeAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  activeResolve?.();
  activeResolve = null;
}

function wordBoundaryAt(text: string, estimate: number): number {
  let index = Math.max(0, Math.min(text.length, Math.floor(estimate)));
  while (index < text.length && !/\s/.test(text[index])) index++;
  return index;
}

async function speakWithKokoro(text: string, opts: SpeakOptions): Promise<void> {
  const controller = new AbortController();
  activeController = controller;
  const response = await fetch(`${API_BASE}/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice: opts.voiceName ?? "kokoro_af_heart",
      speed: Math.max(0.8, Math.min(1.2, opts.rate ?? 1.0)),
    }),
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`speech backend returned ${response.status}`);
  const blob = await response.blob();
  if (controller.signal.aborted) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  await new Promise<void>((resolve, reject) => {
    let lastProgress = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      if (activeController === controller) activeController = null;
      if (activeResolve === finish) activeResolve = null;
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      if (activeController === controller) activeController = null;
      if (activeResolve === finish) activeResolve = null;
      reject(error);
    };
    activeResolve = finish;
    audio.ontimeupdate = () => {
      if (!opts.onProgress || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const estimate = text.length * Math.min(1, audio.currentTime / audio.duration);
      const boundary = wordBoundaryAt(text, estimate);
      if (boundary > lastProgress) {
        lastProgress = boundary;
        opts.onProgress(boundary);
      }
    };
    audio.onended = () => {
      opts.onProgress?.(text.length);
      finish();
    };
    audio.onerror = () => {
      fail(new Error("audio playback failed"));
    };
    void audio.play().catch((error) => fail(error as Error));
  });
}

async function speakWithBrowser(text: string, opts: SpeakOptions): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    opts.onProgress?.(text.length);
    return;
  }
  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts.rate ?? 1.0;
    utterance.pitch = opts.pitch ?? 1.0;
    utterance.onboundary = (event) => {
      const start = event.charIndex ?? 0;
      opts.onProgress?.(wordBoundaryAt(text, start));
    };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (activeResolve === finish) activeResolve = null;
      opts.onProgress?.(text.length);
      resolve();
    };
    activeResolve = finish;
    utterance.onend = utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  });
}

export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const clean = text.trim();
  if (!clean || !ttsAvailable()) return;
  cancelSpeech();
  try {
    await speakWithKokoro(clean.slice(0, 500), opts);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    await speakWithBrowser(clean, opts);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
