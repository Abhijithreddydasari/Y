import { afterEach, describe, expect, it, vi } from "vitest";
import { paintLayout } from "./katex";

// Font ascents (px at 22px) that differ like KaTeX_Main and KaTeX_Math do.
const ASCENT: Record<string, number> = { KaTeX_Main: 18, KaTeX_Math: 21 };
const BASELINE = 40;

function recorder() {
  const calls: { op: string; args: unknown[]; font?: string }[] = [];
  const ctx = {
    font: "", fillStyle: "", textBaseline: "",
    fillText: (...args: unknown[]) => calls.push({ op: "fillText", args, font: ctx.font }),
    fillRect: (...args: unknown[]) => calls.push({ op: "fillRect", args }),
    measureText: () => ({ fontBoundingBoxAscent: ctx.font.includes("KaTeX_Math") ? ASCENT.KaTeX_Math : ASCENT.KaTeX_Main }),
    save: () => {}, restore: () => {}, beginPath: () => {}, rect: () => {}, clip: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

afterEach(() => { document.body.innerHTML = ""; });

describe("paintLayout", () => {
  it("puts runs in fonts with different ascents on the browser's shared baseline", async () => {
    document.body.innerHTML = `<div id="host"><span data-font="KaTeX_Main" style="font-family: 'KaTeX_Main'; font-size: 22px">3</span><span data-font="KaTeX_Math" style="font-family: 'KaTeX_Math'; font-size: 22px; font-style: italic">x</span><span id="bar" style="border-bottom: 2px solid rgb(0, 0, 0)"></span></div>`;
    const host = document.getElementById("host")!;
    // The browser places each run's box top at baseline minus that font's ascent.
    Range.prototype.getClientRects = function (this: Range) {
      const font = (this.startContainer as Text).parentElement!.dataset.font!;
      return [rect(font === "KaTeX_Math" ? 22 : 10, BASELINE - ASCENT[font], 12, 26)] as unknown as DOMRectList;
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.id === "bar" ? rect(10, 50, 30, 2) : rect(0, 0, 60, 60);
    });
    const { ctx, calls } = recorder();
    await paintLayout(ctx, host, { left: 0, top: 0 });

    const texts = calls.filter((call) => call.op === "fillText");
    expect(texts.map((call) => call.args[0])).toEqual(["3", "x"]);
    expect(texts.map((call) => call.args[2])).toEqual([BASELINE, BASELINE]);
    expect(texts[1].font).toContain("italic");
    // A top + font-size rasterizer would have put them at 44 and 41: two baselines.
    expect(calls).toContainEqual({ op: "fillRect", args: [10, 50, 30, 2] });
  });
});
