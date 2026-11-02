import { afterEach, describe, expect, it, vi } from "vitest";
import { diagramLabels, placeDiagram } from "./mermaid-board";

const parse = vi.fn();
vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({ parseMermaidToExcalidraw: (...args: unknown[]) => parse(...args) }));
afterEach(() => parse.mockReset());

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const nodes = (n: number, gap = 300) => [
  ...Array.from({ length: n }, (_, i) => ({ type: "rectangle", id: `N${i}`, x: 10 + i * gap, y: 50, width: 200, height: 60, label: { text: `node ${i}` } })),
  { type: "arrow", id: "e0", x: 210, y: 80, points: [[0, 0], [100, 0]], start: { id: "N0" }, end: { id: "N1" } },
];

describe("placeDiagram", () => {
  it("moves to the origin, scales into the column and renames ids and bindings", () => {
    const { skeletons, width, height } = placeDiagram(nodes(3) as never, { x: 100, y: 400 }, 400, "d1");
    const els = skeletons as unknown as Loose[];
    expect(width).toBeLessThanOrEqual(400.01);
    expect(els[0]).toMatchObject({ id: "d1-N0", x: 100, y: 400 });
    expect(els[0].label.fontSize).toBeGreaterThanOrEqual(14);
    expect(els[3]).toMatchObject({ id: "d1-e0", start: { id: "d1-N0" }, end: { id: "d1-N1" } });
    expect(els[3].points[1][0]).toBeLessThan(100);
    expect(new Set(els.map((e) => e.groupIds.at(-1)))).toEqual(new Set(["d1-group"]));
    expect(els.every((e) => e.customData.yDiagram === "d1")).toBe(true);
    expect(height).toBeGreaterThan(0);
  });

  it("never scales a small diagram up", () => {
    expect(placeDiagram(nodes(1) as never, { x: 0, y: 0 }, 620, "d2").width).toBeCloseTo(300);
  });
});

describe("LessonRenderer diagram", () => {
  it("converts through Excalidraw's converter in strict mode and advances the column", async () => {
    parse.mockResolvedValue({ elements: nodes(2), files: {} });
    const { LessonRenderer } = await import("./renderer");
    const renderer = new LessonRenderer({ x: 0, y: 0 });
    const result = await renderer.render({ tag: "diagram", args: { mermaid: "flowchart TD\n A --> B" } });
    expect(parse.mock.calls[0][1]).toMatchObject({ securityLevel: "strict", htmlLabels: false });
    expect(result.skeletons.length).toBe(3);
    const after = await renderer.render({ tag: "text", args: { content: "next" } });
    expect((after.skeletons[0] as { y: number }).y).toBeGreaterThan(60);
  });

  it("re-lays a wide left-to-right chain top-down", async () => {
    parse.mockResolvedValueOnce({ elements: nodes(5), files: {} }).mockResolvedValueOnce({ elements: nodes(1), files: {} });
    const { LessonRenderer } = await import("./renderer");
    await new LessonRenderer({ x: 0, y: 0 }).render({ tag: "diagram", args: { mermaid: "flowchart LR\n A --> B --> C --> D --> E" } });
    expect(parse.mock.calls[1][0]).toMatch(/^flowchart TD/);
  });

  it("falls back to its labels as text, never a broken diagram", async () => {
    parse.mockRejectedValue(new Error("Parse error"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { LessonRenderer } = await import("./renderer");
    const result = await new LessonRenderer({ x: 0, y: 0 }).render({ tag: "diagram", args: { mermaid: "flowchart LR\n Q[Query] --> S(Scores) --> W{Softmax}" } });
    expect(result.skeletons).toHaveLength(1);
    expect(result.skeletons[0]).toMatchObject({ type: "text", text: "Query → Scores → Softmax" });
  });

  it("extracts unique labels", () => {
    expect(diagramLabels('graph TD\n A["Query"] --> B[Key]\n C[Key] --> D')).toEqual(["Query", "Key"]);
  });
});

describe("LessonRenderer widget", () => {
  it("emits a placeholder retyped to an embeddable with the spec in customData", async () => {
    const { LessonRenderer } = await import("./renderer");
    const result = await new LessonRenderer({ x: 0, y: 0 }).render({ tag: "widget", args: { kind: "attention", spec: '{"tokens":["a","b"],"temp":1}' } });
    const [el] = result.skeletons as unknown as Loose[];
    expect(result.embeddables).toEqual([el.id]);
    expect(el.link).toBe(`y-widget://${el.id}`);
    expect(el.customData.yWidget).toEqual({ kind: "attention", spec: { tokens: ["a", "b"], temp: 1 } });
    const bad = await new LessonRenderer({ x: 0, y: 0 }).render({ tag: "widget", args: { kind: "plot", spec: "{}" } });
    expect(bad.embeddables).toBeUndefined();
  });
});
