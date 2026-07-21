import { cancelSpeech, speak, switchSpeechVoice, warmSpeech } from "./tts";

interface NarrationItem {
  text: string;
  warmController?: AbortController;
  warmPromise?: Promise<void>;
  warmedVoice?: string;
}

export interface NarrationQueueOptions {
  enabled: boolean;
  voiceName?: string;
  signal?: AbortSignal;
  onActivity?: (active: boolean) => void;
}

/** Ordered narration transport that is deliberately independent of drawing. */
export class NarrationQueue {
  private readonly items: NarrationItem[] = [];
  private voiceName: string;
  private cursor = 0;
  private running: Promise<void> | null = null;
  private cancelled = false;

  constructor(private readonly opts: NarrationQueueOptions) {
    this.voiceName = opts.voiceName ?? "kokoro_af_heart";
    opts.signal?.addEventListener("abort", () => this.cancel(), { once: true });
  }

  enqueue(text: string): void {
    const clean = text.trim().slice(0, 500);
    if (!clean || !this.opts.enabled || this.cancelled) return;
    this.items.push({ text: clean });
    this.prefetchAhead();
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
        // A primitive may have arrived between the loop's final length check
        // and this microtask. Start a fresh drain rather than stranding it.
        if (!this.cancelled && this.cursor < this.items.length) {
          this.running = this.run();
        }
      });
    }
  }

  setVoice(voiceName: string): boolean {
    this.voiceName = voiceName;
    for (let index = this.cursor; index < this.items.length; index += 1) {
      this.items[index].warmController?.abort();
      this.items[index].warmController = undefined;
      this.items[index].warmPromise = undefined;
      this.items[index].warmedVoice = undefined;
    }
    this.prefetchAhead();
    return switchSpeechVoice(voiceName);
  }

  async finish(): Promise<void> {
    await this.running;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const item of this.items) item.warmController?.abort();
    cancelSpeech();
    this.opts.onActivity?.(false);
  }

  private prefetchAhead(): void {
    for (
      let index = this.cursor;
      index < Math.min(this.items.length, this.cursor + 3);
      index += 1
    ) {
      const item = this.items[index];
      if (item.warmPromise && item.warmedVoice === this.voiceName) continue;
      const controller = new AbortController();
      item.warmController = controller;
      item.warmedVoice = this.voiceName;
      item.warmPromise = warmSpeech(item.text, {
        voiceName: this.voiceName,
        signal: controller.signal,
      }).catch(() => undefined);
    }
  }

  private async run(): Promise<void> {
    this.opts.onActivity?.(true);
    try {
      while (this.cursor < this.items.length && !this.cancelled) {
        const item = this.items[this.cursor];
        this.prefetchAhead();
        await item.warmPromise;
        if (this.cancelled) break;
        await speak(item.text, { voiceName: this.voiceName });
        this.cursor += 1;
        this.prefetchAhead();
      }
    } finally {
      this.opts.onActivity?.(false);
    }
  }
}
