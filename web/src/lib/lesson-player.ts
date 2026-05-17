// Coordinates renderer + TTS to play back a sequence of primitives at a
// human pace. The same player powers both the live lesson (primitives
// arriving from SSE) and the replay button (primitives cached in memory).

import type { WhiteboardHandle } from "@/components/Whiteboard";
import { LessonRenderer, type RenderResult } from "./renderer";
import { stripMarkdown } from "./sanitize";
import { cancelSpeech, sleep, speak, ttsAvailable } from "./tts";
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
 * Smooth character-by-character text reveal. A setInterval loop advances one
 * character per tick toward a `target` position that the caller updates (e.g.
 * from TTS word-boundary events). The result: text "writes itself" on the
 * board in lockstep with the narrator's voice.
 */
class TextRevealer {
  private current = 0;
  private target = 0;
  private intervalId: number | undefined;
  private completionCb: (() => void) | null = null;

  constructor(
    private readonly fullText: string,
    private readonly onReveal: (partial: string) => void,
    private readonly charMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  start(): void {
    this.intervalId = window.setInterval(() => this.tick(), this.charMs);
  }

  setTarget(chars: number): void {
    this.target = Math.min(this.fullText.length, Math.max(0, Math.floor(chars)));
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
    this.target = this.fullText.length;
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
    if (this.current < this.target) {
      this.current++;
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
  /** ms between non-speech primitives. */
  visualGapMs?: number;
  /** ms after a [text] primitive renders before its narration starts. */
  speakHeadStartMs?: number;
  onProgress?: (status: string) => void;
  signal?: AbortSignal;
}

export class LessonPlayer {
  private readonly opts: Required<Omit<PlayerOptions, "signal" | "onProgress">> & {
    signal?: AbortSignal;
    onProgress?: (status: string) => void;
  };
  private readonly renderer: LessonRenderer;
  private chain: Promise<void> = Promise.resolve();
  private rendered = 0;
  private speaks = 0;

  constructor(opts: PlayerOptions) {
    this.opts = {
      visualGapMs: 200,
      speakHeadStartMs: 80,
      ttsEnabled: opts.ttsEnabled,
      origin: opts.origin,
      handle: opts.handle,
      onProgress: opts.onProgress,
      signal: opts.signal,
    };
    this.renderer = new LessonRenderer(opts.origin);
  }

  /** Enqueue a primitive. Returns immediately; rendering is sequential. */
  enqueue(tag: PrimitiveTag): void {
    this.chain = this.chain.then(() => this.playOne(tag));
  }

  /** Resolve once every queued primitive has finished playing. */
  async finish(): Promise<void> {
    await this.chain;
  }

  /** Stop any in-flight speech immediately. Future primitives still play. */
  cancel(): void {
    cancelSpeech();
  }

  private async playOne(tag: PrimitiveTag): Promise<void> {
    if (this.opts.signal?.aborted) return;
    try {
      const cleanTag = sanitizeTag(tag);

      const result = await this.renderer.render(cleanTag);
      const { skeletons, files, revealId, revealText, revealWidth, revealHeight, drawAnimation } = result;
      if (skeletons.length === 0) return;

      const { convertToExcalidrawElements } = await loadExcalidraw();
      const els = convertToExcalidrawElements(skeletons, { regenerateIds: false });
      if (files) this.opts.handle.addFiles(files);

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

      this.opts.handle.appendElements(els as unknown as Parameters<
        WhiteboardHandle["appendElements"]
      >[0]);
      this.rendered += 1;
      this.report(`Drew ${this.rendered} element(s). Last: ${cleanTag.tag}`);

      // If this primitive had an animatable diagram, run the stroke-by-
      // stroke reveal BEFORE we move on (or in parallel with the caption TTS
      // when the part has a name).
      if (drawAnimation) {
        await this.playStrokeAnimation(result);
      }

      const hasReveal = !!revealText && !!revealId;
      const willSpeak = hasReveal && this.opts.ttsEnabled && ttsAvailable();

      // Build a mutation helper that always pins width/height so Excalidraw
      // never auto-resizes the element as partial text is shorter than final.
      const dimPatch: Record<string, unknown> = {};
      if (revealWidth != null) dimPatch.width = revealWidth;
      if (revealHeight != null) dimPatch.height = revealHeight;

      const mutate = hasReveal
        ? (partial: string) =>
            this.opts.handle.mutateElement(revealId!, {
              text: partial,
              originalText: partial,
              ...dimPatch,
            })
        : undefined;

      // Blank the element immediately so the user never sees the full text
      // flash before the tutor starts "writing".
      if (hasReveal) mutate!(" ");

      if (willSpeak) {
        // --- TTS on: character reveal synced to speech ---
        await sleep(this.opts.speakHeadStartMs);
        if (this.opts.signal?.aborted) return;
        this.speaks += 1;
        const fullText = revealText!;
        const revealer = new TextRevealer(fullText, mutate!, 45, this.opts.signal);
        revealer.start();
        await speak(fullText, {
          onProgress: (chars) => revealer.setTarget(chars),
        });
        revealer.finish();
        // Small gap so the speech engine fully stops before the next
        // primitive's TTS starts (prevents audio clipping between sections).
        await sleep(120);
      } else if (hasReveal) {
        // --- TTS off: character reveal at a brisk reading pace ---
        const fullText = revealText!;
        const revealer = new TextRevealer(fullText, mutate!, 30, this.opts.signal);
        revealer.start();
        await revealer.revealAll();
        revealer.finish();
      } else {
        // Diagram primitive (equation / box / node / arrow / line).
        await sleep(this.opts.visualGapMs);
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
    if (this.opts.signal?.aborted) return;
    if (!result.drawAnimation) return;
    const { parsedSvg, imageId, caption } = result.drawAnimation;
    const paths = parsedSvg.paths;
    if (!paths.length) {
      // Nothing to animate (e.g. draw_part with only <text> elements).
      // Just fade the image in and bail.
      this.opts.handle.mutateElement(imageId, { opacity: 100 });
      return;
    }

    // Wait one frame so the image element is committed to the DOM and we
    // can read its screen-space rect.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const rect = this.opts.handle.getElementScreenRect(imageId);
    if (!rect) {
      // Whiteboard not ready / element missing. Fade-in fallback.
      this.opts.handle.mutateElement(imageId, { opacity: 100 });
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

      // Pace the animation: total ~1.6s baseline, longer if many paths.
      const totalMs = Math.min(2400, Math.max(900, 240 + 110 * pathEls.length));
      const perPathMs = totalMs / Math.max(1, pathEls.length);

      // Speak the part name in parallel (best effort) while strokes appear.
      const speakPromise: Promise<void> = (caption && this.opts.ttsEnabled && ttsAvailable())
        ? (async () => {
            await sleep(40);
            try { await speak(caption, {}); } catch { /* swallow */ }
          })()
        : Promise.resolve();

      // Animate each path sequentially: kick off transition, wait for it.
      for (let i = 0; i < pathEls.length; i++) {
        if (this.opts.signal?.aborted) break;
        const p = pathEls[i];
        p.style.transition = `stroke-dashoffset ${perPathMs}ms ease-out`;
        // Reading offsetWidth flushes the transition setter so the next
        // assignment actually animates rather than snapping.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        p.getBoundingClientRect();
        p.style.strokeDashoffset = "0";
        await sleep(perPathMs);
      }

      await speakPromise;
    } finally {
      // Fade in the underlying rasterised image and fade out the overlay
      // simultaneously to mask the swap.
      this.opts.handle.mutateElement(imageId, { opacity: 100 });
      overlay.style.opacity = "0";
      await sleep(300);
      overlay.remove();
    }
  }

  private report(s: string): void {
    this.opts.onProgress?.(s);
  }
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
