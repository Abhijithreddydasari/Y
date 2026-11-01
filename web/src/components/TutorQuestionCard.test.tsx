import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TutorTurnState } from "@/hooks/useTutorSession";
import TutorComposer from "./TutorComposer";
import TutorQuestionCard from "./TutorQuestionCard";

const mcq = { qid: "t.3", kind: "mcq" as const, q: "What grows with d_k?", options: ["variance", "the mean"] };

describe("TutorQuestionCard", () => {
  it("submits the chosen option with confidence and offers just tell me", () => {
    const onAnswer = vi.fn();
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={onAnswer} />);
    expect(screen.getByText(mcq.q)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /the mean/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Confidence" }), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith({ choice: "the mean", confidence: 80 });
    fireEvent.click(screen.getByRole("button", { name: "Just tell me" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ reveal: true, confidence: null });
  });

  it("takes free text without confidence and renders nothing when no question waits", () => {
    const onAnswer = vi.fn();
    const { rerender } = render(<TutorQuestionCard question={{ ...mcq, kind: "free", options: [] }} busy={false} cardRect={() => null} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: " the variance " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith({ text: "the variance", confidence: null });
    rerender(<TutorQuestionCard question={null} busy={false} cardRect={() => null} onAnswer={onAnswer} />);
    expect(screen.queryByTestId("tutor-question")).toBeNull();
  });
});

function tutor(overrides: Partial<TutorTurnState> = {}): TutorTurnState {
  return { configured: true, busy: false, draft: "", question: null, caption: "", error: "", timing: null,
    setDraft: vi.fn(), ask: vi.fn(), answer: vi.fn(), cardRect: () => null, ...overrides };
}

describe("TutorComposer", () => {
  it("asks on Enter, shows Stop while busy and reports missing configuration", () => {
    const state = tutor({ draft: "Why divide by root d_k?" });
    const onStop = vi.fn();
    const { rerender } = render(<TutorComposer tutor={state} onStop={onStop} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask the tutor" }), { key: "Enter" });
    expect(state.ask).toHaveBeenCalledWith("Why divide by root d_k?");
    rerender(<TutorComposer tutor={tutor({ busy: true, caption: "Watch the variance." })} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.getByText("Y: Watch the variance.")).toBeInTheDocument();
    rerender(<TutorComposer tutor={tutor({ configured: false, error: "The tutor is not configured on the server (MODEL_API_KEY is missing)." })} onStop={onStop} />);
    expect(screen.getByRole("textbox", { name: "Ask the tutor" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("MODEL_API_KEY");
  });
});
