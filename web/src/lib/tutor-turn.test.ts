import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardError } from "./board-api";
import { moveToPrimitive, questionOf, streamTutorTurn, tutorErrorMessage, type PublicMove } from "./tutor-turn";

afterEach(() => vi.unstubAllGlobals());

function sse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  }), { status, headers: { "Content-Type": "text/event-stream" } });
}

const frame = (event: string, data: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const check: PublicMove = { type: "check", kind: "mcq", q: "What grows?", options: ["variance", "mean"], qid: "t.2" };

describe("tutor move mapping", () => {
  it("maps moves onto existing primitives and a card for questions", () => {
    expect(moveToPrimitive({ type: "seg", id: "s1", goal: "Why scale" })).toEqual({ tag: "title", args: { text: "Why scale" } });
    expect(moveToPrimitive({ type: "write", text: "Sums grow." })).toEqual({ tag: "text", args: { content: "Sums grow." } });
    expect(moveToPrimitive({ type: "equation", latex: "\\sqrt{d_k}" })).toEqual({ tag: "equation", args: { latex: "\\sqrt{d_k}" } });
    expect(moveToPrimitive(check)).toEqual({ tag: "card", args: { id: "y-card-t.2", label: "Check", q: "What grows?", options: "variance\nmean" } });
    expect(moveToPrimitive({ type: "diagram", mermaid: "flowchart LR\n A --> B" })).toEqual({ tag: "diagram", args: { mermaid: "flowchart LR\n A --> B" } });
    expect(moveToPrimitive({ type: "widget", kind: "attention", spec: '{"tokens":["a","b"],"temp":1}' }))
      .toEqual({ tag: "widget", args: { kind: "attention", spec: '{"tokens":["a","b"],"temp":1}' } });
    expect(moveToPrimitive({ type: "say", text: "aside" })).toBeNull();
    expect(moveToPrimitive({ type: "because", refs: ["M1"], text: "You mixed these up last time" }))
      .toEqual({ tag: "chip", args: { text: "You mixed these up last time" } });
    expect(moveToPrimitive({ type: "turn_end", reason: "wait" })).toBeNull();
    expect(questionOf(check)).toEqual({ qid: "t.2", kind: "mcq", q: "What grows?", options: ["variance", "mean"] });
    expect(questionOf({ type: "predict", kind: "mcq", q: "Guess", options: ["a", "b"], qid: "t.0" })?.kind).toBe("predict");
  });
});

describe("streamTutorTurn", () => {
  it("delivers moves in order across chunk splits", async () => {
    const text = frame("turn", { turn_id: "t", outcome: null }) + frame("move", { index: 0, move: { type: "seg", id: "s1", goal: "g" } })
      + frame("move", { index: 1, move: check }) + frame("done", { status: "waiting", question: questionOf(check) });
    const chunks = text.match(/[\s\S]{1,9}/g)!;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(chunks)));
    const moves: string[] = [];
    const onDone = vi.fn();
    await streamTutorTurn("s", { turn_id: "t", kind: "question", text: "hi" }, { onMove: (m) => moves.push(m.type), onDone }, new AbortController().signal);
    expect(moves).toEqual(["seg", "check"]);
    expect(onDone).toHaveBeenCalledWith({ status: "waiting", question: questionOf(check) });
  });

  it("surfaces configuration errors, stream errors and early ends honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "tutor_not_configured" }, { status: 503 })));
    const failed = streamTutorTurn("s", { turn_id: "t", kind: "question", text: "hi" }, { onMove: vi.fn(), onDone: vi.fn() }, new AbortController().signal);
    await expect(failed).rejects.toBeInstanceOf(BoardError);
    expect(tutorErrorMessage(await failed.catch((e) => e))).toContain("MODEL_API_KEY");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([frame("move", { index: 0, move: { type: "write", text: "a" } }),
      frame("error", { message: "The explanation stopped early." })])));
    await expect(streamTutorTurn("s", { turn_id: "t", kind: "question", text: "hi" }, { onMove: vi.fn(), onDone: vi.fn() },
      new AbortController().signal)).rejects.toThrow("stopped early");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse([frame("turn", { turn_id: "t", outcome: null })])));
    await expect(streamTutorTurn("s", { turn_id: "t", kind: "question", text: "hi" }, { onMove: vi.fn(), onDone: vi.fn() },
      new AbortController().signal)).rejects.toThrow("ask again");
  });
});
