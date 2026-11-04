import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Utterance = { text: string; volume: number; voice?: unknown; lang?: string; onstart?: () => void; onend?: () => void; onerror?: () => void };

// The module keeps per-page state (unlocked audio, blocked voice), so each test gets a fresh copy.
async function load() {
  vi.resetModules();
  return import("./tts");
}

function engine(behaviour: "silent" | "works", voices: object[] = [{ name: "Samantha", lang: "en-US", localService: true }]) {
  const spoken: Utterance[] = [];
  const state = {
    speaking: false, pending: false, cancel: vi.fn(), resume: vi.fn(), getVoices: () => voices,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    speak: vi.fn((utterance: Utterance) => {
      spoken.push(utterance);
      if (behaviour === "works" && utterance.text.trim()) {
        setTimeout(() => utterance.onstart?.(), 10);
        setTimeout(() => utterance.onend?.(), 20);
      }
    }),
  };
  vi.stubGlobal("speechSynthesis", state);
  Object.defineProperty(window, "speechSynthesis", { value: state, configurable: true });
  return { state, spoken };
}

describe("speech on browsers that drop audio silently", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("SpeechSynthesisUtterance", class { volume = 1; rate = 1; pitch = 1; constructor(public text: string) {} });
    vi.stubGlobal("Audio", class { src = ""; play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn(); constructor(src?: string) { this.src = src ?? ""; } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  });

  it("finishes the line when the engine never starts, so the question card is not held back", async () => {
    const { speak } = await load();
    const { state } = engine("silent");
    let done: unknown = "waiting";
    void speak("Softmax turns scores into weights.", { browserOnly: true }).then((value) => { done = value; });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(done).toBe("waiting");
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe("browser");
    expect(state.cancel).toHaveBeenCalled();
  });

  it("skips later lines at once after a block, and tries again after a click", async () => {
    const { speak, unlockSpeech } = await load();
    const { state } = engine("silent");
    const first = speak("First line.", { browserOnly: true });
    await vi.advanceTimersByTimeAsync(3_100);
    await first;
    state.speak.mockClear();
    await expect(speak("Second line.", { browserOnly: true })).resolves.toBe("browser");
    expect(state.speak).not.toHaveBeenCalled();
    unlockSpeech();
    state.speak.mockClear();
    const third = speak("Third line.", { browserOnly: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.speak).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_100);
    await third;
  });

  it("ends the line if a voice starts and then never reports its end", async () => {
    const { speak } = await load();
    const { spoken } = engine("silent");
    let done = false;
    void speak("Short line.", { browserOnly: true }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    spoken[0].onstart?.();
    await vi.advanceTimersByTimeAsync(5_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it("a working voice speaks normally and is not cut off", async () => {
    const { speak } = await load();
    const { state, spoken } = engine("works");
    const said = speak("Hello there.", { browserOnly: true });
    await vi.advanceTimersByTimeAsync(30);
    await expect(said).resolves.toBe("browser");
    expect(spoken[0].text).toBe("Hello there.");
    expect(state.cancel).not.toHaveBeenCalled(); // a cancel just before speaking makes some browsers drop the speech
  });

  it("a click starts silent speech and audio, once each, and only when nothing is playing", async () => {
    const { unlockSpeech, installSpeechUnlock } = await load();
    const { state, spoken } = engine("works");
    const stop = installSpeechUnlock();
    window.dispatchEvent(new Event("touchend"));
    expect(spoken).toHaveLength(1);
    expect(spoken[0].volume).toBe(0);
    state.speaking = true;
    unlockSpeech();
    expect(spoken).toHaveLength(1);
    state.speaking = false;
    stop();
    window.dispatchEvent(new Event("touchend"));
    expect(spoken).toHaveLength(1);
  });

  it("prefers a voice on this device over Chrome's network voices", async () => {
    const { speak } = await load();
    const { spoken } = engine("works", [
      { name: "Google UK English Female", lang: "en-GB", localService: false },
      { name: "Jenny Online", lang: "en-US", localService: false },
      { name: "Samantha", lang: "en-US", localService: true },
    ]);
    const said = speak("Hi.", { browserOnly: true });
    await vi.advanceTimersByTimeAsync(30);
    await said;
    expect(spoken[0].voice).toMatchObject({ name: "Samantha" });
    expect(spoken[0].lang).toBe("en-US");
  });

  it("a hosted clip the browser refuses to play falls back to the browser voice", async () => {
    const { speak } = await load();
    const { spoken } = engine("works");
    vi.stubGlobal("Audio", class { src = ""; play = vi.fn().mockRejectedValue(new Error("NotAllowedError")); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn(); });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const blob = new Blob(["RIFF"], { type: "audio/wav" });
    const said = speak("Hosted line.", { voiceName: "kokoro_af_heart", prepared: Promise.resolve({ text: "Hosted line.", voiceName: "kokoro_af_heart", blob }) });
    await vi.advanceTimersByTimeAsync(50);
    await expect(said).resolves.toBe("browser");
    expect(spoken.at(-1)?.text).toBe("Hosted line.");
  });

  it("a hosted clip that never starts falls back within five seconds", async () => {
    const { speak } = await load();
    const { spoken } = engine("works");
    vi.stubGlobal("Audio", class { src = ""; play = vi.fn(() => new Promise(() => {})); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn(); });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const blob = new Blob(["RIFF"], { type: "audio/wav" });
    const said = speak("Stuck clip.", { voiceName: "kokoro_af_heart", prepared: Promise.resolve({ text: "Stuck clip.", voiceName: "kokoro_af_heart", blob }) });
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(said).resolves.toBe("browser");
    expect(spoken.at(-1)?.text).toBe("Stuck clip.");
  });
});
