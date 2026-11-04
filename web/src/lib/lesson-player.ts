// Coordinates renderer + TTS to play back a sequence of primitives at a
// human pace. The same player powers both the live lesson (primitives
// arriving from SSE) and the replay button (primitives cached in memory).
//
// Two pacings:
// - "lockstep" (legacy lessons): each [text]/[title] line is written on the
//   board in lockstep with the words being spoken, and the next primitive
//   does not begin until the current line has finished speaking. Non-spoken
//   primitives (equations, diagrams) hold for a short beat.
// - "segment" (tutor turns): the voice is the turn's `say` moves. A segment's
//   heading goes up at once; its other moves wait until the first clip is
//   ready and the previous narration has ended, then are written across the
//   time the voice takes. A question waits until the voice has finished. With
//   the voice off, the board is written at board speed.

import type { WhiteboardHandle } from "@/components/Whiteboard";
import { LessonRenderer, wrapText, type RenderResult } from "./renderer";
import { stripMarkdown } from "./sanitize";
import {
  cancelSpeech,
  prepareSpeech,
  sleep,
  speak,
  switchSpeechVoice,
  type PreparedSpeech,
} from "./tts";
import type { PrimitiveTag } from "./types";

// Cache the dynamic Excalidraw import at module scope. Without this every
// primitive triggers its own `await import("@excalidraw/excalidraw")`, which
// in Turbopack dev mode produces a flood of "Unexpected import of module ...
// deleted by an HMR update" warnings whenever a lesson is in flight while
// any file is edited. With the cache, it's exactly one import per session.
let _excalidrawModule: Promise<typeof import("@excalidraw/excalidraw")> | null = null;
function loadExcalidraw() {
  if (!_excalidrawModule) {
    _excalidrawModule = import("@excalidraw/excalidraw");
  }
  return _excalidrawModule;
}

/**
 * A timed character reveal. It begins immediately while speech is prepared,
 * so the board never waits on the audio round trip before starting to write.
 */
class TextRevealer {
  private current = 0;
  private intervalId: number | undefined;
  private completionCb: (() => void) | null = null;

  constructor(
    private readonly fullText: string,
    private readonly onReveal: (partial: string) => void,
    private readonly charMs: number,
    private readonly signal?: AbortSignal,
    private readonly step = 1,
  ) {}

  start(): void {
    this.intervalId = window.setInterval(() => this.tick(), this.charMs);
  }

  /** Snap to full text and stop. */
  finish(): void {
    this.stop();
    if (this.current < this.fullText.length) {
      this.current = this.fullText.length;
      this.paint();
    }
  }

  /** Set target to end and return a Promise that resolves when the reveal
   *  interval naturally reaches the last character. */
  revealAll(): Promise<void> {
    if (this.current >= this.fullText.length) {
      this.stop();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.completionCb = resolve;
    });
  }

  private tick(): void {
    if (this.signal?.aborted) {
      this.stop();
      this.completionCb?.();
      return;
    }
    if (this.current < this.fullText.length) {
      this.current = Math.min(this.fullText.length, this.current + this.step);
      this.paint();
      if (this.current >= this.fullText.length) {
        this.stop();
        this.completionCb?.();
      }
    }
  }

  private paint(): void {
    this.onReveal(this.fullText.slice(0, this.current) || " ");
  }

  private stop(): void {
    if (this.intervalId !== undefined) {
      window.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

interface PlayerOptions {
  validateSource?: () => boolean;
  origin: { x: number; y: number };
  handle: WhiteboardHandle;
  ttsEnabled: boolean;
  voiceName?: string;
  /** ms to hold on a non-spoken primitive (equation/diagram) before moving on. */
  visualGapMs?: number;
  onProgress?: (status: string) => void;
  onNarratingChange?: (narrating: boolean) => void;
  /** Called once a primitive's elements are on the board (timing, anchoring answer controls). */
  onRendered?: (tag: PrimitiveTag, ids: string[]) => void;
  signal?: AbortSignal;
  pacing?: "lockstep" | "segment";
  /** Segment pacing: the line now being spoken (or shown, when muted). */
  onCaption?: (text: string) => void;
  /** Segment pacing: a line became audible `waitMs` after its visuals were done (first-audio timing). */
  onAudible?: (value: { text: string; engine: "kokoro" | "browser"; waitMs: number }) => void;
  /** Speak with the browser voice only (the learner picked it), never requesting Kokoro. */
  browserOnly?: boolean;
}

/**
 * What one segment says, and what to read aloud if the model gave it no `say`. With the voice on, its board moves
 * wait in `held` until the audio is ready, then are written across the clip's length.
 */
interface Segment { says: string[]; writes: string[]; question: string; held: PrimitiveTag[]; voiced: boolean; narration?: Promise<void> }

/**
 * How long a clause waits for its clip before the browser voice takes over. This is a failure guard, not a speed
 * limit: a short silence is far better than a robotic voice for the rest of the turn.
 */
const CLIP_WAIT_MS = 20_000;
/** How long a segment's writing waits for its first clip. Past this it writes anyway, and the voice joins when ready. */
const WRITING_WAIT_MS = 6_000;
/** Speaking rate assumed until a real clip gives one (seconds per character, from measured clips). */
const SECONDS_PER_CHAR = 0.06;
/** Writing ends a little before the voice, so the learner never waits on the last word being written. */
const WRITING_SHARE = 0.92;
/** How much of a segment's time an equation, widget or diagram gets, counted in characters of text. */
const VISUAL_WEIGHT = 30;
/** A sentence longer than this is split at a comma, so one clip never holds the voice back for long. */
const LONG_SENTENCE_WORDS = 28;
/**
 * Split a spoken line into clips at sentence ends. Each clip is synthesized alone and restarts its intonation, so
 * cutting at commas made the voice sound choppy (Deepgram: about 1.5 s for a clause, 2.7 s for a sentence, 6 s for a
 * whole line). Only an unusually long sentence is split, at its most central comma.
 */
export function clauses(line: string): string[] {
  const out: string[] = [];
  const count = (text: string) => text.trim().split(/\s+/).length;
  for (const sentence of line.trim().split(/(?<=[.!?])\s+/)) {
    const words = count(sentence);
    const cuts = words > LONG_SENTENCE_WORDS ? [...sentence.matchAll(/[,;:—]\s+/g)].map((m) => m.index! + 1) : [];
    const cut = cuts.sort((a, b) => Math.abs(count(sentence.slice(0, a)) - words / 2) - Math.abs(count(sentence.slice(0, b)) - words / 2))[0];
    if (cut) out.push(sentence.slice(0, cut).trim(), sentence.slice(cut).trim());
    else if (sentence) out.push(sentence);
  }
  return out;
}

/** A WAV clip's length from its header, or null if it cannot be read. */
export async function wavSeconds(blob: Blob): Promise<number | null> {
  try {
    const header = new DataView(await blob.slice(0, 44).arrayBuffer());
    const byteRate = header.getUint32(28, true);
    return byteRate > 0 ? Math.max(0, blob.size - 44) / byteRate : null;
  } catch {
    return null;
  }
}

export class LessonPlayer {
  private readonly validateSource?: () => boolean;
  private readonly origin: { x: number; y: number };
  private readonly handle: WhiteboardHandle;
  private readonly ttsEnabled: boolean;
  private voiceName: string;
  private readonly visualGapMs: number;
  private readonly onProgress?: (status: string) => void;
  private readonly onNarratingChange?: (narrating: boolean) => void;
  private readonly onRendered?: (tag: PrimitiveTag, ids: string[]) => void;
  private readonly signal?: AbortSignal;
  private readonly segmentPacing: boolean;
  private readonly onCaption?: (text: string) => void;
  private readonly onAudible?: PlayerOptions["onAudible"];

  private readonly renderer: LessonRenderer;
  // Segment pacing: the open segment, the voice queue and each closed segment's narration.
  private segment: Segment | null = null;
  private voiceChain: Promise<void> = Promise.resolve();
  private readonly narrations: Promise<void>[] = [];
  private pendingNarrations = 0;
  private muted = false;
  private silenced = false;
  private browserOnly = false;
  // One synthesis request at a time: the server is serial per voice anyway, and parallel fetches would
  // take the browser's few connections to this origin away from board saves.
  private warmChain: Promise<unknown> = Promise.resolve();
  private drawChain: Promise<void> = Promise.resolve();
  private rendered = 0;
  private readonly renderedIds: string[] = [];
  private narrating = false;
  // Audio clips warmed at stream time, keyed by the exact narration string,
  // so a line's playback can start with no synthesis gap when its turn comes.
  private readonly warmed = new Map<string, Promise<PreparedSpeech | undefined>>();
  // While set, the primitive being played is written across this many milliseconds, in time with the voice.
  private spanMs: number | null = null;
  // Resolved by cancel(), so waits on the voice end at once and the rest of the segment is simply written.
  private releaseWaits: () => void = () => {};
  private readonly silencedNow = new Promise<void>((resolve) => { this.releaseWaits = resolve; });

  constructor(opts: PlayerOptions) {
    this.validateSource = opts.validateSource;
    this.origin = opts.origin;
    this.handle = opts.handle;
    this.ttsEnabled = opts.ttsEnabled;
    this.voiceName = opts.voiceName ?? "kokoro_af_heart";
    this.browserOnly = opts.browserOnly ?? false;
    this.visualGapMs = opts.visualGapMs ?? 380;
    this.onProgress = opts.onProgress;
    this.onNarratingChange = opts.onNarratingChange;
    this.onRendered = opts.onRendered;
    this.signal = opts.signal;
    this.segmentPacing = opts.pacing === "segment";
    this.onCaption = opts.onCaption;
    this.onAudible = opts.onAudible;
    this.renderer = new LessonRenderer(opts.origin);
    opts.signal?.addEventListener("abort", () => this.cancel(), { once: true });
  }

  /** Segment pacing: a new segment starts; the open one closes and may start speaking. */
  beginSegment(): void {
    this.closeSegment();
    this.segment = this.newSegment();
    // The voice always talks about the segment being written: this one waits for the last one's voice to end.
    const gate = this.narrations.at(-1);
    if (gate) this.drawChain = this.drawChain.then(() => gate);
  }

  private newSegment(): Segment {
    return { says: [], writes: [], question: "", held: [], voiced: false };
  }

  /** Segment pacing: a spoken line for the open segment, warmed now so it is ready when its turn comes. */
  say(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const segment = (this.segment ??= this.newSegment());
    segment.says.push(clean);
    this.warm(clean);
    // The segment's board moves come before its `say`, so its writing can start with the voice from here.
    if (!segment.voiced && this.voiceOn()) this.startVoiced(segment, segment.says);
  }

  private voiceOn(): boolean {
    return this.ttsEnabled && !this.muted && !this.silenced;
  }

  /** The voice and the segment's held writing start together, once the first clip is ready. */
  private startVoiced(segment: Segment, lines: string[]): void {
    segment.voiced = true;
    const before = Promise.all([this.drawChain, this.voiceChain]);
    const ready = before.then(() => this.secondsPerChar(lines));
    this.pendingNarrations += 1;
    const narration = ready.then(() => this.speakLines(lines)).catch(() => {}).finally(() => {
      this.pendingNarrations -= 1;
      if (!this.pendingNarrations) this.setNarrating(false);
    });
    segment.narration = narration;
    this.voiceChain = narration;
    this.narrations.push(narration);
    this.drawChain = ready.then((rate) => this.writeHeld(segment, rate, lines));
  }

  /** The speaking rate from the first clip, once it is ready. Bounded: the board never waits long on the voice. */
  private async secondsPerChar(lines: string[]): Promise<number> {
    const first = clauses(lines[0] ?? "")[0];
    const clip = first && !this.browserOnly ? this.warmed.get(first) : undefined;
    if (!clip) return SECONDS_PER_CHAR;
    const prepared = await Promise.race([clip, this.silencedNow.then(() => undefined),
      sleep(WRITING_WAIT_MS).then(() => undefined)]);
    const seconds = prepared && await wavSeconds(prepared.blob);
    return seconds && first ? seconds / first.length : SECONDS_PER_CHAR;
  }

  /** Write the segment's held moves across the time the voice takes, each in proportion to its length. */
  private async writeHeld(segment: Segment, rate: number, lines: string[]): Promise<void> {
    const held = segment.held.splice(0);
    const weightOf = (tag: PrimitiveTag) => (tag.tag === "text" ? Math.max(1, narrationTextForTag(tag).length) : VISUAL_WEIGHT);
    const total = held.reduce((sum, tag) => sum + weightOf(tag), 0) || 1;
    const speakingMs = lines.join(" ").length * rate * 1000 * WRITING_SHARE;
    for (const tag of held) {
      this.spanMs = this.silenced || this.muted ? null : (speakingMs * weightOf(tag)) / total;
      await this.playOne(tag);
    }
    this.spanMs = null;
  }

  /** Stop speaking now; mid-turn the board keeps drawing and captions continue. Unmuting resumes at the next line. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) cancelSpeech();
  }

  private warm(text: string): void {
    if (!this.ttsEnabled || this.muted || this.browserOnly) return;
    for (const clause of clauses(text)) {
      if (this.warmed.has(clause)) continue;
      const clip = this.warmChain.then(() => this.silenced || this.browserOnly ? undefined
        : prepareSpeech(clause, { voiceName: this.voiceName, signal: this.signal })).catch(() => undefined);
      this.warmChain = clip;
      this.warmed.set(clause, clip);
    }
  }

  private closeSegment(): void {
    const segment = this.segment;
    if (!segment) return;
    this.segment = null;
    if (segment.voiced) return;
    const lines = segment.says.length ? segment.says : [...segment.writes, segment.question].filter(Boolean);
    if (!segment.says.length) lines.forEach((line) => this.warm(line));
    if (segment.held.length) {
      // Held for the voice, and no `say` came: read what is written, in time with writing it.
      this.startVoiced(segment, lines);
      return;
    }
    const drawn = this.drawChain;
    this.pendingNarrations += 1;
    const narration = Promise.all([drawn, this.voiceChain]).then(() => this.speakLines(lines)).catch(() => {}).finally(() => {
      this.pendingNarrations -= 1;
      if (!this.pendingNarrations) this.setNarrating(false);
    });
    this.voiceChain = narration;
    this.narrations.push(narration);
  }

  private async speakLines(lines: string[]): Promise<void> {
    for (const line of lines) {
      if (this.signal?.aborted || this.silenced) return;
      this.onCaption?.(line);
      if (!this.ttsEnabled || this.muted) continue;
      this.setNarrating(true);
      for (const clause of clauses(line)) {
        if (this.signal?.aborted || this.silenced || this.muted) break;
        const prepared = this.warmed.get(clause);
        this.warmed.delete(clause);
        const started = performance.now();
        const spoken = await speak(clause, { voiceName: this.voiceName, prepared, browserOnly: this.browserOnly,
          preparedWaitMs: CLIP_WAIT_MS,
          onAudible: (engine) => this.onAudible?.({ text: clause, engine, waitMs: performance.now() - started }) });
        // One voice per turn: once the hosted voice has failed, the rest of the turn uses the browser voice.
        if (spoken === "browser") this.browserOnly = true;
      }
    }
  }

  /** Enqueue a primitive. Returns immediately; rendering is sequential. */
  enqueue(tag: PrimitiveTag): void {
    if (this.segmentPacing) {
      const segment = (this.segment ??= this.newSegment());
      if (tag.tag === "text") segment.writes.push(narrationTextForTag(tag).replace(/\s+/g, " "));
      if (tag.tag === "card") segment.question = String(tag.args?.q ?? "");
      if (segment.voiced) {
        // After the `say`, as a question is: it waits until the voice has finished explaining.
        const spoken = segment.narration;
        this.drawChain = this.drawChain.then(() => spoken).then(() => this.playOne(tag));
      } else if (tag.tag === "title" || !this.voiceOn()) {
        // The heading goes up at once, so the learner sees the turn begin while the audio gets ready.
        this.drawChain = this.drawChain.then(() => this.playOne(tag));
      } else {
        segment.held.push(tag);
      }
      return;
    }
    // Warm this line's narration audio the moment it streams in. Playback is
    // gated on the previous line finishing, so by the time this line's turn
    // arrives its clip is already synthesized and speech starts instantly --
    // this is what keeps the voice and the writing in lockstep.
    if (this.ttsEnabled) {
      const narrationText = narrationTextForTag(tag);
      if (narrationText && !this.warmed.has(narrationText)) {
        this.warmed.set(
          narrationText,
          prepareSpeech(narrationText, {
            voiceName: this.voiceName,
            signal: this.signal,
          }).catch(() => undefined),
        );
      }
    }
    this.drawChain = this.drawChain.then(() => this.playOne(tag));
  }

  /** Run a board step in stream order (a pointing ring), skipped after Stop; its ids join the final fit. */
  enqueueStep(step: () => Promise<string[]>): void {
    this.drawChain = this.drawChain.then(async () => {
      if (this.signal?.aborted) return;
      try { this.renderedIds.push(...await step()); } catch { /* a ring that cannot be placed never stops the lesson */ }
    });
  }

  /**
   * Resolve once every queued primitive has finished playing. Lockstep pacing includes speech; segment
   * pacing closes the last segment and returns with its narration still playing (see finishNarration).
   */
  async finishDrawing(): Promise<void> {
    this.closeSegment();
    await this.drawChain;
    this.handle.fitElements(this.renderedIds);
  }

  /** Compatibility alias: completion now means visual + narration completion. */
  async finish(): Promise<void> {
    await this.finishDrawing();
  }

  async finishNarration(): Promise<void> {
    this.closeSegment();
    await Promise.all([this.drawChain, this.voiceChain]);
    this.setNarrating(false);
  }

  /** Stop any in-flight speech immediately; nothing queued in this player speaks afterwards. */
  cancel(): void {
    this.silenced = true;
    this.releaseWaits();
    cancelSpeech();
    this.setNarrating(false);
  }

  /** The learner switched between Kokoro and the browser voice; applies from the next clause. */
  setBrowserOnly(browserOnly: boolean): void {
    this.browserOnly = browserOnly;
  }

  /** Switch the voice for the active line and everything queued after it. */
  setVoice(voiceName: string): boolean {
    this.voiceName = voiceName;
    return switchSpeechVoice(voiceName);
  }

  private setNarrating(active: boolean): void {
    if (this.narrating === active) return;
    this.narrating = active;
    this.onNarratingChange?.(active);
  }

  /**
   * Speak and write `fullText` concurrently. Writing begins immediately while
   * the prepared audio resolves; both must finish before the next primitive.
   */
  private async narrate(
    fullText: string,
    mutate?: (partial: string) => void,
  ): Promise<void> {
    if (this.signal?.aborted) return;
    const clean = fullText.trim();
    if (!clean) {
      mutate?.(fullText);
      return;
    }

    // TTS disabled, or segment pacing (the voice follows the board): still write progressively so the
    // board doesn't snap in, at board speed.
    if (!this.ttsEnabled || this.segmentPacing || this.muted) {
      if (mutate) {
        const step = Math.max(1, Math.ceil(clean.length / 30));
        const ticks = Math.max(1, Math.ceil(fullText.length / step));
        const revealer = new TextRevealer(fullText, mutate, Math.max(16, (this.spanMs ?? 0) / ticks), this.signal, step);
        revealer.start();
        await revealer.revealAll();
        revealer.finish();
      }
      return;
    }

    this.setNarrating(true);
    const prepared =
      this.warmed.get(clean) ??
      prepareSpeech(clean, { voiceName: this.voiceName, signal: this.signal }).catch(
        () => undefined,
      );
    this.warmed.delete(clean);

    const wordCount = clean.split(/\s+/).length;
    const estimatedSpeechMs = Math.min(4_500, Math.max(900, wordCount * 340));
    const revealStep = Math.max(1, Math.ceil(fullText.length / 40));
    const revealTicks = Math.max(1, Math.ceil(fullText.length / revealStep));
    const revealer = mutate
      ? new TextRevealer(
          fullText,
          mutate,
          Math.max(18, estimatedSpeechMs / revealTicks),
          this.signal,
          revealStep,
        )
      : null;
    revealer?.start();
    const writing = revealer?.revealAll() ?? Promise.resolve();
    const speaking = speak(clean, {
      voiceName: this.voiceName,
      prepared,
    });
    await Promise.allSettled([writing, speaking]);
    revealer?.finish();
    // Guarantee the final text is fully painted regardless of how speech ended.
    mutate?.(fullText);
  }

  private async playOne(tag: PrimitiveTag): Promise<void> {
    if (this.signal?.aborted) return;
    if (this.validateSource && !this.validateSource()) { this.cancel(); this.report("Your question changed. Ask again using the updated board."); return; }
    try {
      const cleanTag = sanitizeTag(tag);

      const result = await this.renderer.render(cleanTag);
      const { skeletons, files, revealId, revealText, revealWidth, revealHeight, drawAnimation, embeddables } = result;
      if (skeletons.length === 0) return;

      const { convertToExcalidrawElements } = await loadExcalidraw();
      // Skeletons cannot express embeddables, so widgets convert as rectangles and are retyped here.
      const els = convertToExcalidrawElements(skeletons, { regenerateIds: false })
        .map((el) => (embeddables?.includes(el.id) ? { ...el, type: "embeddable" } as unknown as typeof el : el));
      if (this.validateSource && !this.validateSource()) { this.cancel(); return; }
      if (files) this.handle.addFiles(files);

      // For draw / draw_part: hide the image element initially so the
      // overlay animation can paint the strokes from scratch. The image
      // fades in once the animation completes.
      if (drawAnimation) {
        for (const el of els as unknown as Array<Record<string, unknown>>) {
          if (el.id === drawAnimation.imageId) {
            (el as Record<string, unknown>).opacity = 0;
          }
        }
      }

      this.handle.appendElements(els as unknown as Parameters<
        WhiteboardHandle["appendElements"]
      >[0]);
      const latestIds = els.map((element) => element.id).filter(Boolean);
      this.renderedIds.push(...latestIds);
      const latestId = latestIds.at(-1);
      if (latestId) this.handle.ensureElementVisible(latestId);
      this.rendered += 1;
      this.onRendered?.(cleanTag, latestIds);
      this.report(`Drew ${this.rendered} element(s). Last: ${cleanTag.tag}`);

      // Build a mutation helper that always pins width/height so Excalidraw
      // never auto-resizes the element as partial text is shorter than final.
      const hasReveal = !!revealText && !!revealId;
      const dimPatch: Record<string, unknown> = {};
      if (revealWidth != null) dimPatch.width = revealWidth;
      if (revealHeight != null) dimPatch.height = revealHeight;

      const mutate = hasReveal
        ? (partial: string) =>
            this.handle.mutateElement(revealId!, {
              text: partial,
              originalText: partial,
              ...dimPatch,
            })
        : undefined;

      // Blank the element immediately so the user never sees the full text
      // flash before the tutor starts "writing" it in time with the voice.
      if (hasReveal) mutate!(" ");

      // If this primitive had an animatable diagram, run the stroke-by-stroke
      // reveal while its caption is spoken in parallel.
      if (drawAnimation) {
        const captionSpeech = drawAnimation.caption
          ? this.narrate(drawAnimation.caption)
          : Promise.resolve();
        await this.playStrokeAnimation(result);
        await captionSpeech;
      }

      if (hasReveal) {
        // Write the line on the board word-by-word, paced by the narration.
        await this.narrate(revealText!, mutate!);
      } else if (!drawAnimation) {
        // Silent visual primitive (equation / box / node / arrow / line). Hold
        // a beat so it doesn't flash past; equations get a touch longer since
        // they're the substance of a math step and carry no narration.
        const hold =
          cleanTag.tag === "equation" && !this.segmentPacing
            ? Math.max(this.visualGapMs, 700)
            : this.spanMs ?? this.visualGapMs;
        // Stop or a silenced voice ends a long hold at once, so the rest of the segment is not delayed.
        await Promise.race([sleep(hold), this.silencedNow]);
      }
    } catch (exc) {
      console.warn("[player] failed primitive", tag, exc);
    }
  }

  /**
   * Stroke-by-stroke draw of a draw / draw_part primitive's SVG. Mounts an
   * absolutely-positioned overlay over the image element's screen rect,
   * animates each <path>'s stroke-dashoffset from full length down to 0
   * sequentially, and (optionally) speaks the part's caption in parallel.
   * Once the animation completes, the underlying image element fades in and
   * the overlay is removed.
   *
   * Sized in viewport coordinates so it tracks Excalidraw zoom at the
   * moment of capture; if the user zooms during the animation the overlay
   * will drift -- acceptable for a 2-3s reveal.
   */
  private async playStrokeAnimation(result: RenderResult): Promise<void> {
    if (this.signal?.aborted) return;
    if (!result.drawAnimation) return;
    const { parsedSvg, imageId } = result.drawAnimation;
    const paths = parsedSvg.paths;
    if (!paths.length) {
      // Nothing to animate (e.g. draw_part with only <text> elements).
      // Just fade the image in and bail.
      this.handle.mutateElement(imageId, { opacity: 100 });
      return;
    }

    // Wait one frame so the image element is committed to the DOM and we
    // can read its screen-space rect.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const rect = this.handle.getElementScreenRect(imageId);
    if (!rect) {
      // Whiteboard not ready / element missing. Fade-in fallback.
      this.handle.mutateElement(imageId, { opacity: 100 });
      return;
    }

    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "1000";
    overlay.style.transition = "opacity 280ms ease-out";
    overlay.style.opacity = "1";
    overlay.innerHTML = parsedSvg.outerSvg;

    // Force the inner SVG to fill the overlay box exactly.
    const svg = overlay.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.display = "block";
    }

    document.body.appendChild(overlay);

    try {
      const pathEls = svg ? Array.from(svg.querySelectorAll("path")) as SVGPathElement[] : [];
      // Initial state: every path invisible (offset = length, dasharray = length).
      const lengths: number[] = [];
      for (const p of pathEls) {
        let len = 0;
        try { len = p.getTotalLength(); } catch { len = 100; }
        if (!Number.isFinite(len) || len <= 0) len = 100;
        lengths.push(len);
        p.style.strokeDasharray = String(len);
        p.style.strokeDashoffset = String(len);
        p.style.transition = "none";
      }
      // Force a paint of the initial state.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      svg && svg.getBoundingClientRect();

      // Diagram animation remains legible but never stalls streaming.
      const totalMs = Math.min(900, Math.max(360, 100 + 55 * pathEls.length));
      const perPathMs = totalMs / Math.max(1, pathEls.length);

      // Animate each path sequentially: kick off transition, wait for it.
      for (let i = 0; i < pathEls.length; i++) {
        if (this.signal?.aborted) break;
        const p = pathEls[i];
        p.style.transition = `stroke-dashoffset ${perPathMs}ms ease-out`;
        // Reading offsetWidth flushes the transition setter so the next
        // assignment actually animates rather than snapping.
        p.getBoundingClientRect();
        p.style.strokeDashoffset = "0";
        await sleep(perPathMs);
      }

    } finally {
      // Fade in the underlying rasterised image and fade out the overlay
      // simultaneously to mask the swap.
      this.handle.mutateElement(imageId, { opacity: 100 });
      overlay.style.opacity = "0";
      await sleep(120);
      overlay.remove();
    }
  }

  private report(s: string): void {
    this.onProgress?.(s);
  }
}

/**
 * The exact string that will be both written and spoken for a primitive, or
 * "" if the primitive is not narrated. MUST match the `revealText` the
 * renderer produces so the warmed audio clip is reused (same cache key).
 */
function narrationTextForTag(tag: PrimitiveTag): string {
  const a = tag.args ?? {};
  if (tag.tag === "text") {
    return wrapText(stripMarkdown(String(a.content ?? "")), 50);
  }
  if (tag.tag === "title") {
    return stripMarkdown(String(a.text ?? ""));
  }
  return "";
}

function sanitizeTag(tag: PrimitiveTag): PrimitiveTag {
  const a = tag.args ?? {};
  if (tag.tag === "text") {
    return {
      ...tag,
      args: { ...a, content: stripMarkdown(String(a.content ?? "")) },
    };
  }
  if (tag.tag === "title") {
    return {
      ...tag,
      args: { ...a, text: stripMarkdown(String(a.text ?? "")) },
    };
  }
  return tag;
}
