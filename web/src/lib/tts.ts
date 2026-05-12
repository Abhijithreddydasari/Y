// Web Speech API wrapper. Phase 0 uses the browser's built-in synthesizer
// because it's free, fast, and runs offline. The first speak() call may have
// 200-500ms of voice-pick latency the first time the page loads; subsequent
// calls are immediate.

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  voiceName?: string;
}

let cachedVoice: SpeechSynthesisVoice | null = null;
let voicesReady: Promise<void> | null = null;

function waitForVoices(): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return Promise.resolve();
  }
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const tryLoad = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        resolve();
      } else {
        window.speechSynthesis.addEventListener(
          "voiceschanged",
          () => resolve(),
          { once: true },
        );
      }
    };
    tryLoad();
  });
  return voicesReady;
}

function pickVoice(preferred?: string): SpeechSynthesisVoice | null {
  if (cachedVoice && !preferred) return cachedVoice;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (preferred) {
    const found = voices.find((v) => v.name === preferred);
    if (found) return found;
  }
  // Prefer a high-quality English voice if available.
  const en = voices.find((v) => /en-(US|GB)/i.test(v.lang) && /natural|neural|premium|enhanced/i.test(v.name))
    || voices.find((v) => /en-US/i.test(v.lang))
    || voices.find((v) => /^en/i.test(v.lang))
    || voices[0];
  cachedVoice = en;
  return en;
}

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function cancelSpeech(): void {
  if (!ttsAvailable()) return;
  window.speechSynthesis.cancel();
}

export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  if (!ttsAvailable() || !text.trim()) return;
  await waitForVoices();
  return new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate ?? 1.05;
    u.pitch = opts.pitch ?? 1.0;
    const voice = pickVoice(opts.voiceName);
    if (voice) u.voice = voice;
    // Hard upper bound: even at ~150 wpm a 200-word utterance is ~80s. Cap at
    // 60s so a stuck speech-synth never blocks the lesson pipeline.
    const maxMs = Math.min(60_000, 1500 + text.length * 80);
    const timer = window.setTimeout(() => {
      try { window.speechSynthesis.cancel(); } catch { /* ignored */ }
      resolve();
    }, maxMs);
    u.onend = () => { window.clearTimeout(timer); resolve(); };
    u.onerror = () => { window.clearTimeout(timer); resolve(); };
    window.speechSynthesis.speak(u);
  });
}

/**
 * Sleep for `ms` milliseconds. Useful between non-speech primitives to give
 * the rendering a human cadence.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
