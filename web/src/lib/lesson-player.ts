// Coordinates renderer + TTS to play back a sequence of primitives at a
// human pace. The same player powers both the live lesson (primitives
// arriving from SSE) and the replay button (primitives cached in memory).

import type { WhiteboardHandle } from "@/components/Whiteboard";
import { LessonRenderer } from "./renderer";
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

      const { skeletons, files, revealId, revealText } =
        await this.renderer.render(cleanTag);
      if (skeletons.length === 0) return;

      const { convertToExcalidrawElements } = await loadExcalidraw();
      const els = convertToExcalidrawElements(skeletons, { regenerateIds: false });
      if (files) this.opts.handle.addFiles(files);
      this.opts.handle.appendElements(els as unknown as Parameters<
        WhiteboardHandle["appendElements"]
      >[0]);
      this.rendered += 1;
      this.report(`Drew ${this.rendered} element(s). Last: ${cleanTag.tag}`);

      const hasReveal = !!revealText && !!revealId;
      const willSpeak = hasReveal && this.opts.ttsEnabled && ttsAvailable();

      // Blank the element immediately so the user never sees the full text
      // flash before the tutor starts "writing".
      if (hasReveal) {
        this.opts.handle.mutateElement(revealId!, {
          text: " ",
          originalText: " ",
        });
      }

      if (willSpeak) {
        // --- TTS on: character reveal synced to speech ---
        await sleep(this.opts.speakHeadStartMs);
        if (this.opts.signal?.aborted) return;
        this.speaks += 1;
        const fullText = revealText!;
        const mutate = (partial: string) =>
          this.opts.handle.mutateElement(revealId!, {
            text: partial,
            originalText: partial,
          });
        // ~45ms/char ≈ 22 chars/sec, roughly matching 150 wpm speech pace.
        const revealer = new TextRevealer(fullText, mutate, 45, this.opts.signal);
        revealer.start();
        await speak(fullText, {
          onProgress: (chars) => revealer.setTarget(chars),
        });
        revealer.finish();
      } else if (hasReveal) {
        // --- TTS off: character reveal at a brisk reading pace ---
        const fullText = revealText!;
        const mutate = (partial: string) =>
          this.opts.handle.mutateElement(revealId!, {
            text: partial,
            originalText: partial,
          });
        const revealer = new TextRevealer(fullText, mutate, 30, this.opts.signal);
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
