// Coordinates renderer + TTS to play back a sequence of primitives at a
// human pace. The same player powers both the live lesson (primitives
// arriving from SSE) and the replay button (primitives cached in memory).

import type { WhiteboardHandle } from "@/components/Whiteboard";
import { LessonRenderer } from "./renderer";
import { cancelSpeech, sleep, speak, ttsAvailable } from "./tts";
import type { PrimitiveTag } from "./types";

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
      const { skeletons, files } = await this.renderer.render(tag);
      if (skeletons.length > 0) {
        const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
        const els = convertToExcalidrawElements(skeletons, { regenerateIds: false });
        if (files) this.opts.handle.addFiles(files);
        this.opts.handle.appendElements(els as unknown as Parameters<
          WhiteboardHandle["appendElements"]
        >[0]);
        this.rendered += 1;
        this.report(`Drew ${this.rendered} element(s). Last: ${tag.tag}`);
      }
      const narratable = textOf(tag);
      if (narratable && this.opts.ttsEnabled && ttsAvailable()) {
        await sleep(this.opts.speakHeadStartMs);
        this.speaks += 1;
        await speak(narratable);
      } else if (skeletons.length > 0) {
        // Visual-only pause so a flurry of equations / boxes doesn't snap
        // into existence instantly.
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

function textOf(tag: PrimitiveTag): string {
  const a = tag.args ?? {};
  if (tag.tag === "title") return String(a.text ?? "");
  if (tag.tag === "text") return String(a.content ?? "");
  return "";
}
