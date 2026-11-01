import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PracticePanel from "./PracticePanel";
import * as api from "@/lib/learning-api";
import { boardRequest, type BoardAttempt } from "@/lib/board-api";
import type { WhiteboardHandle } from "./Whiteboard";

vi.mock("@/lib/board-api", async original => ({ ...await original<typeof import("@/lib/board-api")>(), boardRequest: vi.fn() }));

vi.mock("@/lib/learning-api", async importOriginal => {
  const original = await importOriginal<typeof api>();
  return { ...original, ensureLearningIdentity: vi.fn(), fetchPracticeCatalog: vi.fn(),
    createPracticeSession: vi.fn(), fetchPracticeSession: vi.fn(), captureAnswer: vi.fn(), assessAnswer: vi.fn() };
});

const saved: api.CapturedAnswer = {
  attempt_id: "saved-attempt", session_id: "saved-session", task_id: "number", text: " 4 ", state: "captured", retry_allowed: true,
  source: { event_id: "source", content_hash: "hash", start: 0, end: 3 }, assessment: null,
};
const assessed: api.CapturedAnswer = { ...saved, state: "assessed", assessment: {
  profile_updated: false, provider_error: null,
  observations: [{ dimension: "mathematical", label: "supported", status: "accepted", reasons: ["numeric_result_only"], provider: "deterministic" }],
} };

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  vi.mocked(api.ensureLearningIdentity).mockResolvedValue({});
  vi.mocked(api.createPracticeSession).mockResolvedValue({ session_id: "session" });
  vi.mocked(api.fetchPracticeCatalog).mockResolvedValue({ packs: [{ pack_id: "pack", title: "Stereo geometry", tasks: [{ task_id: "number", prompt: "What is the depth?", concept_ids: ["depth"] }] }] });
  vi.mocked(api.fetchPracticeSession).mockResolvedValue({ attempts: [] });
  vi.mocked(api.captureAnswer).mockResolvedValue(saved);
  vi.mocked(api.assessAnswer).mockResolvedValue(assessed);
});
afterEach(cleanup);

async function open() {
  render(<PracticePanel />);
  fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  await screen.findByLabelText("Your answer");
}

describe("Practice evidence flow", () => {
  it.each([false, true])("renders repeated crop hashes once across restore and assessment (crop metadata: %s)", async withMetadata => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = "a".repeat(64), second = "b".repeat(64);
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    const answer: BoardAttempt = { attempt_id: "board-attempt", packet: {
      source: { session_id: "session", revision: 1, element_revisions: {}, content_hash: "source", crop_hashes: [first, first, second, second] },
      task_id: "number", focused: [], response_area: bounds,
      coverage: { complete: true, omitted: 0, outside_task: [], missing_visual: [] },
      ...(withMetadata ? { crops: [
        { asset_hash: first, bounds, element_ids: ["ink"], purpose: "initial" as const },
        { asset_hash: first, bounds, element_ids: ["ink"], purpose: "detail" as const },
        { asset_hash: second, bounds, element_ids: ["more-ink"], purpose: "initial" as const },
      ] } : {}),
    }, result: null, corrections: [] };
    vi.mocked(boardRequest).mockResolvedValueOnce([answer]).mockResolvedValueOnce(answer)
      .mockResolvedValueOnce({ ...answer, result: { status: "pending_review", provider_error: null, observations: [], interpretation: null } });
    const board = { board: { session: "session", state: { regions: [] } } } as unknown as WhiteboardHandle;
    try {
      render(<PracticePanel board={board} />);
      fireEvent.click(screen.getByRole("button", { name: "Practice" }));
      await screen.findByText("Board answer · revision 1");
      expect(screen.getAllByRole("link", { name: "View original crop", hidden: true })).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Retry board assessment" }));
      await screen.findByText("pending review");
      const links = screen.getAllByRole("link", { name: "View original crop", hidden: true });
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute("href", `/api/learning/sessions/session/board/assets/${first}`);
      expect(links[1]).toHaveAttribute("href", `/api/learning/sessions/session/board/assets/${second}`);
      expect(error.mock.calls.some(args => args.some(arg => String(arg).includes("same key")))).toBe(false);
    } finally { error.mockRestore(); }
  });
  it("saves exact learner text before assessment and shows a receipt", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: " 4 " } });
    fireEvent.click(screen.getByLabelText("I used hints or outside help"));
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    await screen.findByText(/Numerical answer checks out/);
    expect(api.captureAnswer).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ text: " 4 ", assistance: { self_reported_help: true, solution_revealed: false } }));
    expect(vi.mocked(api.captureAnswer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.assessAnswer).mock.invocationCallOrder[0]);
    expect(screen.getByText(/These checks do not yet update/)).toBeInTheDocument();
    expect(screen.getByText("Evidence receipt")).toBeInTheDocument();
  });

  it("reuses the same attempt after a lost capture response", async () => {
    vi.mocked(api.captureAnswer).mockRejectedValueOnce(new Error("Connection lost"));
    await open();
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Your answer")).toHaveValue("4");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved answer" }));
    await screen.findByText(/Numerical answer checks out/);
    const calls = vi.mocked(api.captureAnswer).mock.calls;
    expect(calls[0][1]).toEqual(calls[1][1]);
  });

  it("restores saved evidence and labels unavailable assessments honestly", async () => {
    vi.mocked(api.fetchPracticeSession).mockResolvedValue({ attempts: [{ ...saved, assessment: {
      profile_updated: false, provider_error: "provider_not_configured",
      observations: [{ dimension: "conceptual", label: "not_observable", status: "abstained", reasons: ["provider_not_configured"], provider: "none" }],
    } }] });
    await open();
    expect(await screen.findByText(/Assessment unavailable. Your answer is saved/)).toBeInTheDocument();
    expect(screen.getByText(/your answer has not been judged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry assessment" }));
    await screen.findByText(/Numerical answer checks out/);
    expect(api.captureAnswer).not.toHaveBeenCalled();
  });

  it("shows provisional results without a mastery claim", async () => {
    vi.mocked(api.assessAnswer).mockResolvedValue({ ...assessed, assessment: {
      profile_updated: false, provider_error: null,
      observations: [{ dimension: "conceptual", label: "supported", status: "pending_review", reasons: ["jev_shadow_mode"], provider: "jev" }],
    } });
    await open();
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Depth halves." } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    await screen.findByText(/Needs review/);
    expect(screen.queryByText(/mastered/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Your answer")).toHaveValue(""));
  });
});
