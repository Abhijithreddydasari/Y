import { describe, expect, it } from "vitest";
import { frameStats, installFrameProbe } from "./frame-probe";

describe("frame probe", () => {
  it("summarises frame intervals", () => {
    const stats = frameStats([16.7, 16.6, 16.8, 33.4, 16.7]);
    expect(stats).toMatchObject({ frames: 5, p50: 16.7, max: 33.4, over20: 1 });
  });

  it("turns glass off on request and installs nothing by default", () => {
    const stop = installFrameProbe("?glass=0");
    expect(document.documentElement.dataset.glass).toBe("off");
    expect((window as { __boardFrames?: unknown }).__boardFrames).toBeUndefined();
    stop();
    delete document.documentElement.dataset.glass;
  });
});
