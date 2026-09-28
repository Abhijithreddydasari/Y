import { describe, expect, it } from "vitest";
import { lessonContext, primitiveToMarkdown } from "./chat";

describe("lesson Markdown transcript", () => {
  it("uses fuller chat reasoning without changing the board caption", () => {
    const tag = { tag: "text" as const, args: { content: "Resolve gravity along the slope.", explanation: "Split gravity into two components. The parallel component accelerates the block." } };
    expect(primitiveToMarkdown(tag)).toBe(tag.args.explanation);
    expect(tag.args.content).toBe("Resolve gravity along the slope.");
    expect(primitiveToMarkdown({ tag: "text", args: { content: "Legacy caption.", explanation: " " } })).toBe("Legacy caption.");
  });
  it("preserves headings, prose, equations, and diagram captions", () => {
    expect(primitiveToMarkdown({ tag: "title", args: { text: "Integration" } })).toBe("## Integration");
    expect(primitiveToMarkdown({ tag: "text", args: { content: "Integrate each term." } })).toBe("Integrate each term.");
    expect(primitiveToMarkdown({ tag: "equation", args: { latex: "x^2 + C" } })).toBe("$$\nx^2 + C\n$$");
    expect(primitiveToMarkdown({ tag: "draw", args: { caption: "Area under the curve" } })).toBe("*Diagram: Area under the curve*");
  });

  it("builds context from whiteboard turns rather than prior chat replies", () => {
    const context = lessonContext([
      { id: "lesson", role: "assistant", source: "lesson", content: "## Derivatives" },
      { id: "user", role: "user", source: "chat", content: "Why?" },
      { id: "reply", role: "assistant", source: "chat", content: "A response" },
    ]);
    expect(context).toContain("Derivatives");
    expect(context).not.toContain("A response");
  });
});
