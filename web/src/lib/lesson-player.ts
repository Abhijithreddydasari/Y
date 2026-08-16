// Coordinates renderer + TTS to play back a sequence of primitives at a
// human pace. The same player powers both the live lesson (primitives
// arriving from SSE) and the replay button (primitives cached in memory).
//
// Narration and writing advance TOGETHER: each [text]/[title] line is written
// on the board in lockstep with the words being spoken (driven by the audio
// clip's playback position), and the next primitive does not begin until the
// current line has finished speaking. Non-spoken primitives (equations,
// diagrams) hold for a short beat so they don't flash past the narration.

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
 * A timed character reveal. Used only when TTS is disabled, so a line still
 * writes progressively instead of snapping in all at once. When TTS is on,
 * the reveal is driven by audio position (see `LessonPlayer.narrate`).
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
  origin: { x: number; y: number };
  handle: WhiteboardHandle;
  ttsEnabled: boolean;
  voiceName?: string;
  /** ms to hold on a non-spoken primitive (equation/diagram) before moving on. */
  visualGapMs?: number;
  onProgress?: (status: string) => void;
  onNarratingChange?: (narrating: boolean) => void;
  signal?: AbortSignal;
}

export class LessonPlayer {
  private readonly origin: { x: number; y: number };
  private readonly handle: WhiteboardHandle;
  private readonly ttsEnabled: boolean;
  private voiceName: string;
  private readonly visualGapMs: number;
  private readonly onProgress?: (status: string) => void;
  private readonly onNarratingChange?: (narrating: boolean) => void;
  private readonly signal?: AbortSignal;

  private readonly renderer: LessonRenderer;
  private drawChain: Promise<void> = Promise.resolve();
  private rendered = 0;
  private readonly renderedIds: string[] = [];
  private narrating = false;
  // Audio clips warmed at stream time, keyed by the exact narration string,
  // so a line's playback can start with no synthesis gap when its turn comes.
  private readonly warmed = new Map<string, Promise<PreparedSpeech | undefined>>();

  constructor(opts: PlayerOptions) {
    this.origin = opts.origin;
    this.handle = opts.handle;
    this.ttsEnabled = opts.ttsEnabled;
    this.voiceName = opts.voiceName ?? "kokoro_af_heart";
    this.visualGapMs = opts.visualGapMs ?? 380;
    this.onProgress = opts.onProgress;
    this.onNarratingChange = opts.onNarratingChange;
    this.signal = opts.signal;
    this.renderer = new LessonRenderer(opts.origin);
    opts.signal?.addEventListener("abort", () => this.cancel(), { once: true });
  }

  /** Enqueue a primitive. Returns immediately; rendering is sequential. */
  enqueue(tag: PrimitiveTag): void {
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

  /** Resolve once every queued primitive has finished playing (and speaking). */
  async finishDrawing(): Promise<void> {
    await this.drawChain;
    this.handle.fitElements(this.renderedIds);
  }

  /** Compatibility alias: completion now means visual + narration completion. */
  async finish(): Promise<void> {
    await this.finishDrawing();
  }

  async finishNarration(): Promise<void> {
    await this.drawChain;
    this.setNarrating(false);
  }

  /** Stop any in-flight speech immediately. */
  cancel(): void {
    cancelSpeech();
    this.setNarrating(false);
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
   * Speak `fullText` while (optionally) writing it on the board in lockstep.
   * Resolves only when the audio clip has finished, so the caller can gate the
   * next primitive on the current line being fully spoken.
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

    // TTS disabled: still write progressively so the board doesn't snap in.
    if (!this.ttsEnabled) {
      if (mutate) {
        const step = Math.max(1, Math.ceil(clean.length / 30));
        const revealer = new TextRevealer(fullText, mutate, 16, this.signal, step);
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

    try {
      await speak(clean, {
        voiceName: this.voiceName,
        prepared,
        onProgress: mutate
          ? (chars) => {
              const n = Math.max(0, Math.min(fullText.length, chars));
              mutate(fullText.slice(0, n) || " ");
            }
          : undefined,
      });
    } catch {
      // A synthesis / playback failure must not strand the line half-written.
    }
    // Guarantee the final text is fully painted regardless of how speech ended.
    mutate?.(fullText);
  }

  private async playOne(tag: PrimitiveTag): Promise<void> {
    if (this.signal?.aborted) return;
    try {
      const cleanTag = sanitizeTag(tag);

      const result = await this.renderer.render(cleanTag);
      const { skeletons, files, revealId, revealText, revealWidth, revealHeight, drawAnimation } = result;
      if (skeletons.length === 0) return;

      const { convertToExcalidrawElements } = await loadExcalidraw();
      const els = convertToExcalidrawElements(skeletons, { regenerateIds: false });
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
          cleanTag.tag === "equation"
            ? Math.max(this.visualGapMs, 700)
            : this.visualGapMs;
        await sleep(hold);
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
