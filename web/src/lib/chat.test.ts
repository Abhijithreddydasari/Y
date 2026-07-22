import { describe, expect, it } from "vitest";
import { lessonContext, primitiveToMarkdown } from "./chat";

describe("lesson Markdown transcript", () => {
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
