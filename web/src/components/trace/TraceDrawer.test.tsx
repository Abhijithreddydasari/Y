import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TraceDrawer from "./TraceDrawer";
import { labelerName, modelName } from "@/lib/trace";

vi.mock("@/lib/board-api", () => ({ boardSession: () => Promise.resolve("12345678-1234-1234-1234-123456789abc") }));

const TRACE = {
  turns: [
    { stage: "turn", seq: 1, kind: "question", status: "waiting", at: 1, goal: "Spot the subtraction error",
      tutor: { option: "spark-1.3", model: "muse-spark-1.3", effort: "minimal" }, ms: { first_move_ms: 2100, total_ms: 3200 },
      usage: { input_tokens: 2400, output_tokens: 310 }, moves: 8, dropped: 0, repairs: 0, error: null, model_call: true,
      points: [{ snap: "line", line: 2, lines: 3 }] },
    { stage: "turn", seq: 2, kind: "review", status: "waiting", at: 2, goal: "Warm-up from last time", tutor: null,
      ms: { total_ms: 290 }, usage: {}, moves: 3, dropped: 0, repairs: 0, error: null, model_call: false, points: [] },
  ],
  hints: [{ stage: "hint", qid: "t.3", level: 1, at: 3, ms: 2600, tutor: { option: "spark-1.3", model: "muse-spark-1.3", effort: "minimal" }, usage: {} }],
  labels: [{ stage: "label", qid: "t.3", status: "labeled", error: null, labeler: "baseten", model: "meta-models/muse-spark-open-1026", verifier: "option",
    modality: "tap", images: 0, ms: { label_ms: 5300, provider_ms: 420, queue_ms: 10 } }],
  close: { stage: "close", revision: 4, ms: 5970, sealed: 2, notes_model: "meta-models/muse-spark-open-1026",
    notes: { kept: 2, named: ["m1"], links: 1 }, relabel: { requeued: 0 } },
};

afterEach(() => vi.unstubAllGlobals());

describe("TraceDrawer", () => {
  it("shows which model did each stage and its latency, newest turn first", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(TRACE)));
    vi.stubGlobal("fetch", fetcher);
    render(<TraceDrawer timing={{ first_move_ms: 2150, first_render_ms: 2190, total_ms: 9000 }} onClose={() => {}} />);
    expect(await screen.findByText("#1 question: Spot the subtraction error")).toBeTruthy();
    expect(fetcher.mock.calls[0][0]).toBe("/api/learning/sessions/12345678-1234-1234-1234-123456789abc/trace");
    const turns = screen.getAllByText(/^#\d/).map((node) => node.textContent);
    expect(turns[0]).toMatch(/^#2 review/);
    expect(screen.getAllByText("Muse Spark 1.3 · minimal")).toHaveLength(2);
    expect(screen.getByText("Stored check (no model)")).toBeTruthy();
    expect(screen.getByText(/1 ring \(line 2, line\)/)).toBeTruthy();
    expect(screen.getAllByText("Muse Spark Open")).toHaveLength(2); // the label and the session close
    expect(screen.queryByText(/OpenAI/)).toBeNull();
    expect(screen.getByText("First move drawn")).toBeTruthy();
    expect(screen.getByText("3.20 s")).toBeTruthy();
  });

  it("closes with Escape and says so when the trace cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    const onClose = vi.fn();
    render(<TraceDrawer timing={null} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("The trace is unavailable right now.")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("names models for judges", () => {
    expect(modelName("muse-spark-1.3", "minimal")).toBe("Muse Spark 1.3 · minimal");
    expect(modelName(null)).toBe("no model");
    expect(labelerName({ ...TRACE.labels[0], stage: "label", model: null, labeler: "deterministic" })).toBe("Verifier (no model)");
  });
});
