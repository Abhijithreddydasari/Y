import { describe, expect, it } from "vitest";
import { LessonRenderer } from "./renderer";

describe("LessonRenderer card", () => {
  it("draws a framed question with lettered options under the previous line", async () => {
    const renderer = new LessonRenderer({ x: 100, y: 200 });
    await renderer.render({ tag: "title", args: { text: "Why scale" } });
    const { skeletons } = await renderer.render({ tag: "card", args: { id: "y-card-t.3", label: "Check", q: "What grows?", options: "variance\nthe mean" } });
    const [frame, text] = skeletons as unknown as Record<string, unknown>[];
    expect(frame).toMatchObject({ type: "rectangle", id: "y-card-t.3", x: 100 });
    expect(frame.y as number).toBeGreaterThan(200);
    expect(text).toMatchObject({ type: "text", id: "y-card-t.3-text", text: "Check: What grows?\nA. variance\nB. the mean" });
    expect((await renderer.render({ tag: "card", args: { id: "", q: "x" } })).skeletons).toEqual([]);
  });
});
