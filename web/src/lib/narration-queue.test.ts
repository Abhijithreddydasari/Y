import { beforeEach, describe, expect, it, vi } from "vitest";

const { playback, speakMock, warmMock, switchMock, cancelMock } = vi.hoisted(() => {
  const ordered: string[] = [];
  return {
    playback: ordered,
    speakMock: vi.fn(async (text: string, options?: { prepared?: Promise<unknown> }) => {
      await options?.prepared;
      ordered.push(text);
    }),
    warmMock: vi.fn(async (text: string, options?: { signal?: AbortSignal }) => {
      void text;
      void options;
      return undefined;
    }),
    switchMock: vi.fn(() => true),
    cancelMock: vi.fn(),
  };
});

vi.mock("./tts", () => ({
  speak: speakMock,
  prepareSpeech: warmMock,
  switchSpeechVoice: switchMock,
  cancelSpeech: cancelMock,
}));

import { NarrationQueue } from "./narration-queue";

describe("NarrationQueue", () => {
  beforeEach(() => {
    playback.length = 0;
    vi.clearAllMocks();
  });

  it("preserves narration order without coupling callers to playback", async () => {
    const queue = new NarrationQueue({ enabled: true, voiceName: "heart" });
    queue.enqueue("first sentence");
    queue.enqueue("second sentence");
    await queue.finish();
    expect(playback).toEqual(["first sentence", "second sentence"]);
    expect(warmMock).toHaveBeenCalled();
  });

  it("invalidates old-voice prefetch and switches active transport", async () => {
    const aborted: string[] = [];
    warmMock.mockImplementation((text: string, options?: { signal?: AbortSignal }) =>
      new Promise<undefined>((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          aborted.push(text);
          resolve(undefined);
        }, { once: true });
      }),
    );
    const queue = new NarrationQueue({ enabled: true, voiceName: "heart" });
    queue.enqueue("pending sentence");
    expect(queue.setVoice("michael")).toBe(true);
    queue.cancel();
    await queue.finish();
    expect(aborted).toContain("pending sentence");
    expect(switchMock).toHaveBeenCalledWith("michael");
    expect(cancelMock).toHaveBeenCalled();
  });
});
