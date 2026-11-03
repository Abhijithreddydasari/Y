import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import type { TurnBody, TutorTurnEvents } from "@/lib/tutor-turn";
import { BOARD_QUESTION } from "@/lib/tutor-turn";
import { useTutorSession } from "./useTutorSession";

const mocks = vi.hoisted(() => ({
  fetchTutorState: vi.fn(),
  streamTutorTurn: vi.fn(),
  enqueued: [] as { tag: string; args: Record<string, unknown> }[],
  voice: [] as string[],
  fetchTutorOptions: vi.fn(),
  fetchReview: vi.fn(),
  fetchSessionStatus: vi.fn(),
  closeSession: vi.fn(),
  requestHint: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ fetchHealth: vi.fn().mockResolvedValue(null), fetchLearner: vi.fn().mockResolvedValue(null),
  resetLearner: vi.fn(), streamAssessment: vi.fn(), streamChat: vi.fn(), streamLesson: vi.fn() }));
vi.mock("@/lib/tts", () => ({ cancelSpeech: vi.fn() }));
vi.mock("@/lib/board-api", async (original) => ({ ...await original<object>(), boardSession: vi.fn().mockResolvedValue("sid") }));
vi.mock("@/lib/tutor-turn", async (original) => ({ ...await original<object>(),
  fetchTutorState: mocks.fetchTutorState, streamTutorTurn: mocks.streamTutorTurn, fetchReview: mocks.fetchReview,
  fetchSessionStatus: mocks.fetchSessionStatus, closeSession: mocks.closeSession, requestHint: mocks.requestHint }));
vi.mock("@/lib/tutor-options", async (original) => ({ ...await original<object>(), fetchTutorOptions: mocks.fetchTutorOptions }));
vi.mock("@/lib/lesson-player", () => ({
  LessonPlayer: class {
    constructor(private opts: { onRendered?: () => void; onCaption?: (text: string) => void; pacing?: string; browserOnly?: boolean }) {
      mocks.voice.push(`pacing:${opts.pacing}`);
      if (opts.browserOnly) mocks.voice.push("browser-only");
    }
    setBrowserOnly(value: boolean) { mocks.voice.push(`browser-only:${value}`); }
    setVoice(id: string) { mocks.voice.push(`voice:${id}`); return false; }
    enqueue(tag: { tag: string; args: Record<string, unknown> }) { mocks.enqueued.push(tag); this.opts.onRendered?.(); }
    beginSegment() { mocks.voice.push("segment"); }
    say(text: string) { mocks.voice.push(`say:${text}`); this.opts.onCaption?.(text); }
    setMuted(muted: boolean) { mocks.voice.push(`muted:${muted}`); }
    async finishDrawing() {}
    async finishNarration() {}
    cancel() { mocks.voice.push("cancel"); }
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
    mocks.voice.length = 0;
    mocks.fetchTutorState.mockResolvedValue({ configured: true, model: "m", open: null, turns: [] });
    mocks.fetchTutorOptions.mockResolvedValue(null);
    mocks.fetchReview.mockResolvedValue([]);
    mocks.fetchSessionStatus.mockResolvedValue({ memory: true, status: "open" });
    mocks.closeSession.mockReturnValue(new Promise(() => {}));  // a real close reloads the page
    window.localStorage.clear();
  });

  it("Ask with an empty box answers the question on the board, and a blank board makes no call", async () => {
    const blank = { ...board(), getElements: () => [], board: { ...board().board, state: { records: {} } } } as unknown as WhiteboardHandle;
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(blank));
    await waitFor(() => expect(result.current.tutor.configured).toBe(true));
    act(() => result.current.tutor.ask("  "));
    expect(mocks.streamTutorTurn).not.toHaveBeenCalled();
    expect(result.current.tutor.error).toMatch(/Write or draw your question/);

    const ink = { id: "ink1", type: "freedraw", isDeleted: false };
    const written = { ...board(), getElements: () => [ink], board: { ...board().board, state: { records: { ink1: { creator: "human" } } } } } as unknown as WhiteboardHandle;
    act(() => result.current.onWhiteboardReady(written));
    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => { h.onTurn?.({ turn_id: "t9", outcome: null }); h.onDone({ status: "done", question: null }); }));
    await act(async () => { result.current.tutor.ask(""); });
    expect(mocks.streamTutorTurn.mock.calls[0][1]).toMatchObject({ kind: "question", text: BOARD_QUESTION });
  });

  it("runs warm-up → answer → hint → exit ticket → close without dead ends", async () => {
    const due = { concept: "attention.softmax", reason: "misconception", q: question.q, retention: 1, mean: 0.4 };
    mocks.fetchReview.mockResolvedValue([due]);
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(board()));
    await waitFor(() => expect(result.current.tutor.warmup.visible).toBe(true));

    const review = { ...question, origin: "review" as const };
    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t1", outcome: null });
      h.onMove({ type: "check", kind: "mcq", q: question.q, options: question.options, qid: question.qid }, 1);
      h.onDone({ status: "waiting", question: review });
    }));
    await act(async () => { result.current.tutor.warmup.start(); });
    expect(mocks.streamTutorTurn.mock.calls[0][1]).toMatchObject({ kind: "review", concept: "attention.softmax" });
    await waitFor(() => expect(result.current.tutor.question?.origin).toBe("review"));
    expect(result.current.tutor.warmup.items).toEqual([]);

    // Hint ladder on the open card.
    mocks.requestHint.mockResolvedValueOnce([{ level: 1, text: "Nudge." }]);
    await act(async () => { result.current.tutor.hints.next(); });
    await waitFor(() => expect(result.current.tutor.hints.given).toHaveLength(1));
    expect(mocks.requestHint).toHaveBeenCalledWith("sid", question.qid, 1);

    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t2", outcome: { qid: question.qid, result: "correct" } });
      h.onMove({ type: "write", text: "Right." }, 0);
      h.onDone({ status: "done", question: null });
    }));
    await act(async () => { result.current.tutor.answer({ choice: "variance", confidence: null }); });
    await waitFor(() => expect(result.current.tutor.question).toBeNull());
    expect(result.current.tutor.hints.given).toEqual([]);

    // End session offers the exit ticket first; its answer flows into the close.
    act(() => result.current.tutor.endSession());
    expect(result.current.tutor.exit.offered).toBe(true);
    expect(mocks.closeSession).not.toHaveBeenCalled();
    const ticket = { ...question, qid: "t3.1", origin: "exit" as const };
    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t3", outcome: null });
      h.onMove({ type: "check", kind: "mcq", q: question.q, options: question.options, qid: ticket.qid }, 1);
      h.onDone({ status: "waiting", question: ticket });
    }));
    await act(async () => { result.current.tutor.exit.take(); });
    expect(mocks.streamTutorTurn.mock.calls[2][1]).toMatchObject({ kind: "exit" });
    await waitFor(() => expect(result.current.tutor.question?.origin).toBe("exit"));
    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t4", outcome: { qid: ticket.qid, result: "correct" } });
      h.onDone({ status: "done", question: null });
    }));
    await act(async () => { result.current.tutor.answer({ choice: "variance", confidence: null }); });
    await waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith("sid"));
  });

  it("a failed exit turn falls back to a plain end; a sealed canvas offers no warm-up", async () => {
    mocks.fetchTutorState.mockResolvedValue({ configured: true, model: "m", open: null,
      turns: [{ turn_id: "a", seq: 1, kind: "answer", status: "done", learner: "x", goals: [], said: [] }] });
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(board()));
    await waitFor(() => expect(result.current.tutor.configured).toBe(true));
    act(() => result.current.tutor.endSession());
    expect(result.current.tutor.exit.offered).toBe(true);
    mocks.streamTutorTurn.mockRejectedValueOnce(new Error("The tutor took too long."));
    await act(async () => { result.current.tutor.exit.take(); });
    await waitFor(() => expect(result.current.tutor.exit.offered).toBe(true));
    act(() => result.current.tutor.exit.skip());
    await waitFor(() => expect(mocks.closeSession).toHaveBeenCalled());

    mocks.fetchReview.mockClear();
    mocks.fetchSessionStatus.mockResolvedValue({ memory: true, status: "closed" });
    const sealed = renderHook(() => useTutorSession());
    await waitFor(() => expect(sealed.result.current.tutor.sealed).toBe(true));
    expect(sealed.result.current.tutor.warmup.visible).toBe(false);
    expect(mocks.fetchReview).not.toHaveBeenCalled();
  });

  it("sends the picked model, applies the picked voice and restores both after a refresh", async () => {
    const opt = (id: string, extra = {}) => ({ id, label: id, note: "", default: false, available: true, reason: null, ...extra });
    mocks.fetchTutorOptions.mockResolvedValue({ models: [opt("spark-1.3", { default: true }), opt("spark-1.2")],
      voices: [opt("kokoro_af_heart", { default: true }), opt("kokoro_am_michael"), opt("browser"), opt("off")] });
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(board()));
    await waitFor(() => expect(result.current.tutor.picker.options).not.toBeNull());
    expect(result.current.tutor.picker.prefs).toEqual({ model: "spark-1.3", voice: "kokoro_af_heart" });

    act(() => { result.current.tutor.picker.setModel("spark-1.2"); result.current.tutor.picker.setVoice("browser"); });
    const trace = { option: "spark-1.2", model: "muse-spark-1.2", effort: "minimal" };
    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t5", outcome: null });
      h.onMove({ type: "write", text: "Step." }, 0);
      h.onDone({ status: "done", question: null, tutor: trace });
    }));
    await act(async () => { result.current.tutor.ask("Why?"); });
    await waitFor(() => expect(result.current.tutor.picker.trace).toEqual(trace));
    expect(mocks.streamTutorTurn.mock.calls[0][1]).toMatchObject({ model: "spark-1.2" });
    expect(mocks.voice).toContain("browser-only");

    act(() => result.current.tutor.picker.setVoice("off"));
    expect(result.current.ttsEnabled).toBe(false);
    act(() => result.current.toggleTts());
    expect(result.current.tutor.picker.prefs.voice).toBe("kokoro_af_heart");
    act(() => result.current.tutor.picker.setVoice("kokoro_am_michael"));
    expect(result.current.voice).toBe("kokoro_am_michael");

    const refreshed = renderHook(() => useTutorSession());
    await waitFor(() => expect(refreshed.result.current.tutor.picker.prefs).toEqual({ model: "spark-1.2", voice: "kokoro_am_michael" }));
    expect(refreshed.result.current.voice).toBe("kokoro_am_michael");
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
    // The say is bound to its segment in the player, which captions it when it is spoken.
    expect(mocks.voice).toEqual(["pacing:segment", "muted:false", "segment", "say:Watch the sums."]);
    expect(result.current.tutor.caption).toBe("Watch the sums.");
    act(() => result.current.toggleTts());
    expect(mocks.voice.at(-1)).toBe("muted:true");
    expect(result.current.ttsEnabled).toBe(false);
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
    expect(mocks.streamTutorTurn.mock.calls[1][1]).not.toHaveProperty("via"); // a tap: the server records it as tap
    expect(result.current.tutor.question).toBeNull();
    expect(handle.mutateElement).toHaveBeenCalledWith("y-card-t1.2-text", expect.objectContaining({ text: expect.stringContaining("You answered: the mean (70% sure)") }));
  });

  it("sends an answer typed in the composer to the open card as typed evidence; a question stays a question", async () => {
    const { result } = renderHook(() => useTutorSession());
    act(() => result.current.onWhiteboardReady(board()));
    await waitFor(() => expect(result.current.tutor.configured).toBe(true));
    mocks.streamTutorTurn.mockImplementationOnce(scripted((h) => {
      h.onTurn?.({ turn_id: "t1", outcome: null });
      h.onMove({ type: "check", kind: "mcq", q: question.q, options: question.options, qid: question.qid }, 0);
      h.onDone({ status: "waiting", question });
    }));
    await act(async () => { result.current.tutor.ask("Why divide by root d_k?"); });
    await waitFor(() => expect(result.current.tutor.question).toEqual(question));

    mocks.streamTutorTurn.mockImplementation(scripted((h) => { h.onTurn?.({ turn_id: "t", outcome: null }); h.onDone({ status: "waiting", question }); }));
    await act(async () => { result.current.tutor.ask("Why is it the variance?"); });
    await waitFor(() => expect(result.current.tutor.busy).toBe(false));
    expect(mocks.streamTutorTurn.mock.calls[1][1]).toMatchObject({ kind: "question", text: "Why is it the variance?" });

    act(() => result.current.tutor.setDraft("A, the sums spread out"));
    await act(async () => { result.current.tutor.ask("A, the sums spread out"); });
    await waitFor(() => expect(result.current.tutor.busy).toBe(false));
    expect(mocks.streamTutorTurn.mock.calls[2][1]).toMatchObject({ kind: "answer", question_id: question.qid, choice: "variance",
      text: "A, the sums spread out", via: "typed" });
    expect(result.current.tutor.draft).toBe("");
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
