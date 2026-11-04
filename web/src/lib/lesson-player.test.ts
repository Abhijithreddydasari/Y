import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import { clauses, LessonPlayer, wavSeconds } from "./lesson-player";

const tts = vi.hoisted(() => ({ log: [] as string[], finish: new Map<string, () => void>() }));
vi.mock("./tts", () => ({
  cancelSpeech: vi.fn(() => { tts.log.push("cancel"); tts.finish.forEach((done) => done()); }),
  prepareSpeech: vi.fn(async (text: string) => { tts.log.push(`warm:${text}`); return undefined; }),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  speak: vi.fn((text: string) => new Promise((resolve) => {
    tts.log.push(`speak:${text}`);
    tts.finish.set(text, () => { tts.finish.delete(text); resolve("kokoro"); });
  })),
  switchSpeechVoice: vi.fn(),
}));
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (skeletons: Record<string, unknown>[]) => skeletons.map((s, i) => ({ id: `el${tts.log.length}-${i}`, ...s })),
}));

function handle() {
  return {
    appendElements: (elements: { text?: string; label?: { text: string } }[]) => {
      const text = elements.map((e) => e.text).find(Boolean);
      tts.log.push(`draw:${text?.split("\n")[0]}`);
    },
    mutateElement: vi.fn(), ensureElementVisible: vi.fn(), fitElements: vi.fn(), addFiles: vi.fn(), getElementScreenRect: () => null,
  } as unknown as WhiteboardHandle;
}

const until = (check: () => boolean) => vi.waitFor(() => { if (!check()) throw new Error("not yet"); }, { timeout: 4_000, interval: 10 });
const at = (entry: string) => tts.log.indexOf(entry);
const player = (captions: string[] = []) => new LessonPlayer({ origin: { x: 0, y: 0 }, handle: handle(), ttsEnabled: true,
  pacing: "segment", visualGapMs: 0, onCaption: (text) => captions.push(text) });

beforeEach(() => { tts.log.length = 0; tts.finish.clear(); });

describe("clauses", () => {
  it("makes one clip per sentence, keeping commas in, so the intonation holds", () => {
    expect(clauses("Look at the sums. They grow with d k!")).toEqual(["Look at the sums.", "They grow with d k!"]);
    expect(clauses("Each of the 512 products adds a little variance, so together their sum spreads out by about twenty two.")).toEqual([
      "Each of the 512 products adds a little variance, so together their sum spreads out by about twenty two."]);
  });

  it("splits only a very long sentence, at its most central comma", () => {
    const left = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen,";
    const right = "sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven twentyeight twentynine.";
    expect(clauses(`${left} ${right}`)).toEqual([left, right]);
  });
});

describe("wavSeconds", () => {
  it("reads a clip's length from its header", async () => {
    const bytes = new Uint8Array(44 + 96_000);
    new DataView(bytes.buffer).setUint32(28, 48_000, true);
    const blob = { size: bytes.length, slice: () => ({ arrayBuffer: async () => bytes.buffer }) } as unknown as Blob;
    expect(await wavSeconds(blob)).toBe(2);
    expect(await wavSeconds({ slice: () => { throw new Error("no"); } } as unknown as Blob)).toBeNull();
  });
});

describe("LessonPlayer segment pacing", () => {
  it("holds a segment's writing until its voice starts, then the next waits for the voice to end", async () => {
    const captions: string[] = [];
    const p = player(captions);
    p.beginSegment(); p.enqueue({ tag: "title", args: { text: "Why scale" } }); p.enqueue({ tag: "text", args: { content: "Sums grow." } });
    p.say("Look how the sums grow.");
    p.beginSegment(); p.enqueue({ tag: "title", args: { text: "Divide" } }); p.say("So we divide.");
    p.beginSegment(); p.enqueue({ tag: "title", args: { text: "Check" } }); p.say("Your turn.");
    const drawn = p.finishDrawing();

    // Warmed as soon as each say streamed in, before anything is spoken.
    await until(() => at("warm:Your turn.") >= 0);
    expect(tts.log.filter((entry) => entry.startsWith("warm:"))).toEqual(["warm:Look how the sums grow.", "warm:So we divide.", "warm:Your turn."]);
    await until(() => at("speak:Look how the sums grow.") >= 0);
    // The heading goes up first; the writing starts with the voice, not before it.
    expect(at("draw:Why scale")).toBeLessThan(at("speak:Look how the sums grow."));
    await until(() => at("draw:Sums grow.") >= 0);
    expect(at("draw:Sums grow.")).toBeGreaterThan(at("speak:Look how the sums grow."));
    // Segment 2 waits while segment 1 is being explained.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(at("draw:Divide")).toBe(-1);

    tts.finish.get("Look how the sums grow.")!();
    await until(() => at("speak:So we divide.") >= 0);
    expect(at("draw:Divide")).toBeGreaterThan(at("speak:Look how the sums grow."));
    expect(at("draw:Divide")).toBeLessThan(at("speak:So we divide."));
    expect(at("draw:Check")).toBe(-1);
    tts.finish.get("So we divide.")!();
    await until(() => at("speak:Your turn.") >= 0);
    await drawn;
    expect(at("draw:Check")).toBeGreaterThan(at("speak:So we divide."));
    expect(at("speak:Your turn.")).toBeGreaterThan(at("draw:Check"));
    tts.finish.get("Your turn.")!();
    await p.finishNarration();
    expect(captions).toEqual(["Look how the sums grow.", "So we divide.", "Your turn."]);
  });

  it("shows a question only after the voice has finished explaining", async () => {
    const p = player();
    p.beginSegment(); p.enqueue({ tag: "text", args: { content: "Sums grow." } }); p.say("Look how the sums grow.");
    p.enqueue({ tag: "card", args: { id: "y-card-t.2", label: "Check", q: "What grows?", options: "" } });
    const drawn = p.finishDrawing();
    await until(() => at("draw:Sums grow.") >= 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(at("draw:Check: What grows?")).toBe(-1);
    tts.finish.get("Look how the sums grow.")!();
    await drawn;
    expect(at("draw:Check: What grows?")).toBeGreaterThan(at("draw:Sums grow."));
  });

  it("writes everything at board speed with the voice off, and still writes after the voice is silenced", async () => {
    const muted = player();
    muted.setMuted(true);
    muted.beginSegment(); muted.enqueue({ tag: "text", args: { content: "Quiet line." } }); muted.say("Spoken line.");
    await muted.finishDrawing();
    expect(at("draw:Quiet line.")).toBeGreaterThanOrEqual(0);

    tts.log.length = 0;
    const hushed = player();
    hushed.beginSegment(); hushed.enqueue({ tag: "text", args: { content: "Kept line." } }); hushed.say("Speaking now.");
    hushed.cancel(); // the learner started talking: silence the voice, keep the lesson
    await hushed.finishDrawing();
    expect(at("draw:Kept line.")).toBeGreaterThanOrEqual(0);
  });

  it("reads the written lines and the question when a segment has no say", async () => {
    const p = player();
    p.beginSegment();
    p.enqueue({ tag: "text", args: { content: "Dot products grow with dimension." } });
    p.enqueue({ tag: "card", args: { id: "y-card-t.1", label: "Check", q: "What grows?", options: "variance\nthe mean" } });
    await p.finishDrawing();
    await until(() => at("speak:Dot products grow with dimension.") >= 0);
    tts.finish.get("Dot products grow with dimension.")!();
    await until(() => at("speak:What grows?") >= 0);
    expect(at("speak:What grows?")).toBeGreaterThan(at("draw:Check: What grows?"));
  });

  it("speaks nothing after Stop, and keeps captions but no voice while muted", async () => {
    const stopped = player();
    stopped.beginSegment(); stopped.enqueue({ tag: "title", args: { text: "One" } }); stopped.say("First.");
    stopped.beginSegment(); stopped.say("Second.");
    // Drawing the second segment waits for the first one's voice; Stop releases both.
    const drawing = stopped.finishDrawing();
    await until(() => at("speak:First.") >= 0);
    stopped.cancel();
    await drawing;
    await stopped.finishNarration();
    expect(at("speak:Second.")).toBe(-1);

    tts.log.length = 0;
    const captions: string[] = [];
    const muted = player(captions);
    muted.setMuted(true);
    muted.beginSegment(); muted.say("Quiet one."); muted.beginSegment(); muted.say("Quiet two.");
    await muted.finishNarration();
    expect(captions).toEqual(["Quiet one.", "Quiet two."]);
    expect(tts.log.filter((entry) => entry.startsWith("speak:") || entry.startsWith("warm:"))).toEqual([]);
  });
});
