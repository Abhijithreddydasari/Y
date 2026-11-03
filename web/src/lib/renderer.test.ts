import { describe, expect, it } from "vitest";
import { cardNote, LessonRenderer } from "./renderer";

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

describe("LessonRenderer chip", () => {
  it("draws a because chip in the narration column and moves the next line below it", async () => {
    const renderer = new LessonRenderer({ x: 100, y: 200 });
    const { skeletons } = await renderer.render({ tag: "chip", args: { text: "You mixed up the mean last time" } });
    const [chip] = skeletons as unknown as Record<string, unknown>[];
    expect(chip).toMatchObject({ type: "rectangle", x: 100, y: 200, height: 30 });
    expect((chip.label as { text: string }).text).toBe("\u21ba You mixed up the mean last time");
    const next = (await renderer.render({ tag: "text", args: { content: "Next" } })).skeletons[0] as unknown as { y: number };
    expect(next.y).toBeGreaterThanOrEqual(230);
    expect((await renderer.render({ tag: "chip", args: { text: "" } })).skeletons).toEqual([]);
  });
});

describe("cardNote", () => {
  it("wraps the answer to the card width and grows the card by its lines", () => {
    const note = cardNote("You answered: Positive, because distance is always positive (65% sure)");
    expect(note.text.split("\n").length).toBe(2);
    expect(note.text.replace("\n", " ")).toContain("always positive (65% sure)");
    expect(note.extra).toBe(Math.ceil(18 * 1.25 * 3));
  });

  it("keeps a long typed answer to three lines", () => {
    const note = cardNote(`You answered: ${"word ".repeat(80)}`);
    expect(note.text.split("\n")).toHaveLength(3);
    expect(note.text.endsWith("…")).toBe(true);
  });
});
