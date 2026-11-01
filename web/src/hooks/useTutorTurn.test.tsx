import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import type { TurnBody, TutorTurnEvents } from "@/lib/tutor-turn";
import { useTutorSession } from "./useTutorSession";

const mocks = vi.hoisted(() => ({
  fetchTutorState: vi.fn(),
  streamTutorTurn: vi.fn(),
  enqueued: [] as { tag: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/api", () => ({ fetchHealth: vi.fn().mockResolvedValue(null), fetchLearner: vi.fn().mockResolvedValue(null),
  resetLearner: vi.fn(), streamAssessment: vi.fn(), streamChat: vi.fn(), streamLesson: vi.fn() }));
vi.mock("@/lib/tts", () => ({ cancelSpeech: vi.fn() }));
vi.mock("@/lib/board-api", async (original) => ({ ...await original<object>(), boardSession: vi.fn().mockResolvedValue("sid") }));
vi.mock("@/lib/tutor-turn", async (original) => ({ ...await original<object>(),
  fetchTutorState: mocks.fetchTutorState, streamTutorTurn: mocks.streamTutorTurn }));
vi.mock("@/lib/lesson-player", () => ({
  LessonPlayer: class {
    constructor(private opts: { onRendered?: () => void }) {}
    enqueue(tag: { tag: string; args: Record<string, unknown> }) { mocks.enqueued.push(tag); this.opts.onRendered?.(); }
    async finishDrawing() {}
    cancel() {}
  },
}));

const question = { qid: "t1.2", kind: "mcq" as const, q: "What grows with d_k?", options: ["variance", "the mean"] };

function board() {
  const elements = [
    { id: "y-card-t1.2", type: "rectangle", height: 100 },
    { id: "y-card-t1.2-text", type: "text", text: "Check: What grows with d_k?", height: 60 },
  ];
  const handle = {
    board: { ready: true, session: "sid", flush: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue({ request: { request_id: "r", viewport: { x: 0, y: 0, w: 1000, h: 800 } },
        packet: { focused: [], response_area: { x: 2000, y: 0, w: 4000, h: 4000 } } }) },
    getElements: () => elements,
    mutateElement: vi.fn(),
    getElementScreenRect: vi.fn().mockReturnValue(null),
  };
  return handle as unknown as WhiteboardHandle & { mutateElement: ReturnType<typeof vi.fn> };
}

function scripted(events: (h: TutorTurnEvents) => void) {
  return async (_s: string, _b: TurnBody, handlers: TutorTurnEvents) => { events(handlers); };
}

describe("tutor turn flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueued.length = 0;
    mocks.fetchTutorState.mockResolvedValue({ configured: true, model: "m", open: null, turns: [] });
  });

  it("asks from the composer, draws the turn, waits on the card and resumes on the answer", async () => {
    const { result } = renderHook(() => useTutorSession());
    const handle = board();
    act(() => result.current.onWhiteboardReady(handle));
    await waitFor(() => expect(result.current.tutor.configured).toBe(true));

    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t1", outcome: null });
      h.onMove({ type: "seg", id: "s1", goal: "Why scale" }, 0);
      h.onMove({ type: "say", text: "Watch the sums." }, 1);
      h.onMove({ type: "check", kind: "mcq", q: question.q, options: question.options, qid: question.qid }, 2);
      h.onMove({ type: "turn_end", reason: "wait" }, 3);
      h.onDone({ status: "waiting", question, timing: { first_move_ms: 1800 } });
    }));
    act(() => result.current.tutor.setDraft("Why divide by root d_k?"));
    await act(async () => { result.current.tutor.ask("Why divide by root d_k?"); });
    await waitFor(() => expect(result.current.tutor.question).toEqual(question));
    const body = mocks.streamTutorTurn.mock.calls[0][1] as TurnBody;
    expect(body).toMatchObject({ kind: "question", text: "Why divide by root d_k?", board: { request_id: "r" } });
    expect(mocks.enqueued.map((t) => t.tag)).toEqual(["title", "card"]);
    expect(result.current.tutor.caption).toBe("Watch the sums.");
    expect(result.current.tutor.draft).toBe("");
    expect(result.current.tutor.timing).toMatchObject({ server_first_move_ms: 1800 });
    expect(result.current.tutor.timing?.first_render_ms).toBeGreaterThanOrEqual(0);

    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t2", outcome: { qid: question.qid, result: "incorrect" } });
      h.onMove({ type: "write", text: "Not quite: the spread grows." }, 0);
      h.onDone({ status: "done", question: null });
    }));
    await act(async () => { result.current.tutor.answer({ choice: "the mean", confidence: 70 }); });
    await waitFor(() => expect(result.current.tutor.busy).toBe(false));
    expect(mocks.streamTutorTurn.mock.calls[1][1]).toMatchObject({ kind: "answer", question_id: question.qid, choice: "the mean", confidence: 70 });
    expect(result.current.tutor.question).toBeNull();
    expect(handle.mutateElement).toHaveBeenCalledWith("y-card-t1.2-text", expect.objectContaining({ text: expect.stringContaining("You answered: the mean (70% sure)") }));
  });

  it("keeps the question and board on a configuration error", async () => {
    const { BoardError } = await import("@/lib/board-api");
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(board()));
    await waitFor(() => expect(result.current.tutor.configured).toBe(true));
    mocks.streamTutorTurn.mockRejectedValueOnce(new BoardError(503, "tutor_not_configured"));
    await act(async () => { result.current.tutor.ask("Why?"); });
    await waitFor(() => expect(result.current.tutor.error).toContain("MODEL_API_KEY"));
    expect(result.current.tutor.draft).toBe("Why?");
    expect(result.current.tutor.configured).toBe(false);
  });

  it("stops a running turn, keeping drawn moves, and restores a waiting card after refresh", async () => {
    mocks.fetchTutorState.mockResolvedValue({ configured: true, model: "m", open: null, turns: [] });
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(board()));
    mocks.streamTutorTurn.mockImplementationOnce((_s: string, _b: TurnBody, h: TutorTurnEvents, signal: AbortSignal) => new Promise((_, reject) => {
      h.onTurn?.({ turn_id: "t3", outcome: null });
      h.onMove({ type: "write", text: "First step." }, 0);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await act(async () => { result.current.tutor.ask("Explain eigenvectors"); });
    await waitFor(() => expect(result.current.tutor.busy).toBe(true));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.tutor.busy).toBe(false));
    expect(result.current.status).toBe("Stopped. What was drawn is kept.");
    expect(mocks.enqueued.map((t) => t.tag)).toEqual(["text"]);
    expect(result.current.tutor.error).toBe("");

    mocks.fetchTutorState.mockResolvedValue({ configured: true, model: "m", open: question, turns: [] });
    const refreshed = renderHook(() => useTutorSession());
    await waitFor(() => expect(refreshed.result.current.tutor.question).toEqual(question));
    expect(refreshed.result.current.status).toBe("Your turn: answer the card on the board.");

    // Stopping a new question before anything is drawn leaves the waiting card open.
    act(() => refreshed.result.current.onWhiteboardReady(board()));
    mocks.streamTutorTurn.mockImplementationOnce((_s: string, _b: TurnBody, h: TutorTurnEvents, signal: AbortSignal) => new Promise((_, reject) => {
      h.onTurn?.({ turn_id: "t4", outcome: null });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await act(async () => { refreshed.result.current.tutor.ask("Something else"); });
    await waitFor(() => expect(refreshed.result.current.tutor.busy).toBe(true));
    act(() => refreshed.result.current.stop());
    await waitFor(() => expect(refreshed.result.current.tutor.busy).toBe(false));
    expect(refreshed.result.current.tutor.question).toEqual(question);
  });
});
