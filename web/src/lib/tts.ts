// Web Speech API wrapper. Uses the browser's built-in synthesizer because
// it's free, fast, and runs offline. The first speak() call may have
// 200-500ms of voice-pick latency the first time the page loads; subsequent
// calls are immediate.

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  voiceName?: string;
  /**
   * Called as the synthesizer advances through the text. `charsSpoken` is the
   * length (in original-text characters) the engine has progressed through so
   * far. Used by the lesson player to write the text element word-by-word in
   * lockstep with the voice. Monotonic; never moves backward.
   */
  onProgress?: (charsSpoken: number) => void;
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

    // --- progressive reveal plumbing ---
    // Two paths feed the same monotonic counter:
    //   1. Real `onboundary` events from the engine (Chrome/Edge: word-level).
    //   2. A timer estimate that engages only if no boundary fires for ~600ms,
    //      so Safari (which historically ignores boundary for some voices)
    //      still gets a smooth reveal instead of a single-shot at the end.
    let revealed = 0;
    const reveal = (n: number) => {
      if (!opts.onProgress) return;
      const clamped = Math.min(text.length, Math.max(0, Math.floor(n)));
      if (clamped <= revealed) return;
      revealed = clamped;
      opts.onProgress(revealed);
    };
    let boundaryFired = false;
    let fallbackInterval: number | undefined;
    let fallbackKickoff: number | undefined;
    const stopFallback = () => {
      if (fallbackKickoff !== undefined) {
        window.clearTimeout(fallbackKickoff);
        fallbackKickoff = undefined;
      }
      if (fallbackInterval !== undefined) {
        window.clearInterval(fallbackInterval);
        fallbackInterval = undefined;
      }
    };
    if (opts.onProgress) {
      u.onboundary = (e: SpeechSynthesisEvent) => {
        boundaryFired = true;
        stopFallback();
        if (e.name === "word" || e.name === undefined) {
          const idx = e.charIndex ?? 0;
          // charLength is non-standard; when missing, scan forward to the
          // next whitespace to find the end of the current word.
          let charLen = (e as SpeechSynthesisEvent & { charLength?: number })
            .charLength ?? 0;
          if (charLen === 0) {
            let end = idx;
            while (end < text.length && !/\s/.test(text[end])) end++;
            charLen = end - idx;
          }
          reveal(idx + charLen);
        }
      };
      // Roughly 12.5 chars/sec at rate=1.0 (≈150 wpm, ≈5 chars/word).
      const charsPerMs = 0.0125 * (opts.rate ?? 1.05);
      const TICK_MS = 80;
      fallbackKickoff = window.setTimeout(() => {
        if (boundaryFired) return;
        let lastTick = Date.now();
        fallbackInterval = window.setInterval(() => {
          const now = Date.now();
          const dt = now - lastTick;
          lastTick = now;
          reveal(revealed + Math.max(1, Math.round(dt * charsPerMs)));
        }, TICK_MS);
      }, 600);
    }

    // Chrome/Edge silently kill long utterances after ~15s. A periodic
    // pause+resume keeps the engine alive without audible artefacts.
    let keepaliveId: number | undefined;
    if (/Chrome|Edg/i.test(navigator.userAgent)) {
      keepaliveId = window.setInterval(() => {
        if (!window.speechSynthesis.speaking) return;
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 10_000);
    }
    const stopKeepalive = () => {
      if (keepaliveId !== undefined) {
        window.clearInterval(keepaliveId);
        keepaliveId = undefined;
      }
    };
    // --- end reveal plumbing ---

    const timer = window.setTimeout(() => {
      try { window.speechSynthesis.cancel(); } catch { /* ignored */ }
      stopFallback();
      stopKeepalive();
      reveal(text.length);
      resolve();
    }, maxMs);
    u.onend = () => {
      window.clearTimeout(timer);
      stopFallback();
      stopKeepalive();
      reveal(text.length);
      resolve();
    };
    u.onerror = () => {
      window.clearTimeout(timer);
      stopFallback();
      stopKeepalive();
      reveal(text.length);
      resolve();
    };
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
