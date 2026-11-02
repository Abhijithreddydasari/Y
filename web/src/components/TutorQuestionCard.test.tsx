import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TutorTurnState } from "@/hooks/useTutorSession";
import TutorComposer from "./TutorComposer";
import TutorQuestionCard from "./TutorQuestionCard";

const voice = vi.hoisted(() => ({ start: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/wav-recorder", async (original) => ({ ...await original<object>(), startWavRecording: voice.start }));
vi.mock("@/lib/voice-input", async (original) => ({ ...await original<object>(), transcribe: voice.transcribe, warmTranscription: vi.fn() }));
vi.mock("@/lib/board-api", async (original) => ({ ...await original<object>(), boardSession: vi.fn().mockResolvedValue("sid") }));

/** A recording that has captured `ms` of audio; stop() hands back a WAV blob. */
function recording(ms = 2_000) {
  return { stop: vi.fn().mockResolvedValue(new Blob(["wav"], { type: "audio/wav" })), cancel: vi.fn().mockResolvedValue(undefined), elapsedMs: () => ms, level: () => 0.5 };
}

/** Tap the mic (start), wait for recording, tap again (send). */
async function speak(name: RegExp) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0 });
  fireEvent.pointerUp(screen.getByRole("button", { name: /Recording|Listening/ }));
  const mic = await screen.findByRole("button", { name: /Recording/ });
  await act(async () => { fireEvent.pointerDown(mic, { button: 0 }); });
}

beforeEach(() => { voice.start.mockReset(); voice.transcribe.mockReset(); });

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

  it("answers by voice: a spoken letter picks one option, an unclear answer asks for a tap", async () => {
    const onAnswer = vi.fn(), onListen = vi.fn();
    voice.start.mockResolvedValue(recording());
    voice.transcribe.mockResolvedValueOnce({ text: "I think it's B.", duration: 1 }).mockResolvedValueOnce({ text: "no idea", duration: 1 });
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={onAnswer} onListen={onListen} />);
    await speak(/say a letter/);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ choice: "the mean", confidence: null, via: "spoken" }));
    expect(onListen).toHaveBeenCalled();
    await speak(/say a letter/);
    expect(await screen.findByText('Heard "no idea". Tap the option you mean.')).toBeInTheDocument();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("answers a free-text check with the transcript as said", async () => {
    const onAnswer = vi.fn();
    voice.start.mockResolvedValue(recording());
    voice.transcribe.mockResolvedValueOnce({ text: "The variance equals d k.", duration: 2 });
    render(<TutorQuestionCard question={{ ...mcq, kind: "free", options: [] }} busy={false} cardRect={() => null} onAnswer={onAnswer} />);
    await speak(/answer by voice/);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ text: "The variance equals d k.", confidence: null, via: "spoken" }));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("The variance equals d k.");
  });
});

function tutor(overrides: Partial<TutorTurnState> = {}): TutorTurnState {
  return { configured: true, busy: false, draft: "", question: null, caption: "", error: "", timing: null, narrating: false,
    setDraft: vi.fn(), ask: vi.fn(), answer: vi.fn(), cardRect: () => null, hush: vi.fn(),
    picker: { options: null, prefs: { model: "spark-1.3", voice: "kokoro_af_heart" }, trace: null, setModel: vi.fn(), setVoice: vi.fn() },
    ...overrides };
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

  it("asks with the transcript of one recording, exactly like typed text", async () => {
    const state = tutor();
    voice.start.mockResolvedValue(recording());
    voice.transcribe.mockResolvedValue({ text: "Why do we divide by root d k?", duration: 2 });
    render(<TutorComposer tutor={state} onStop={vi.fn()} />);
    await speak(/ask by voice/);
    await waitFor(() => expect(state.ask).toHaveBeenCalledWith("Why do we divide by root d k?"));
    expect(state.ask).toHaveBeenCalledTimes(1);
    expect(state.hush).toHaveBeenCalled();
    expect(voice.transcribe.mock.calls[0][0]).toBe("sid");
  });

  it("keeps typing usable when the mic is blocked or transcription fails", async () => {
    const { RecorderError } = await import("@/lib/wav-recorder");
    const { BoardError } = await import("@/lib/board-api");
    const state = tutor({ draft: "typed" });
    voice.start.mockResolvedValueOnce(recording()).mockRejectedValueOnce(new RecorderError("denied", "blocked"));
    voice.transcribe.mockRejectedValueOnce(new BoardError(422, "no_speech"));
    render(<TutorComposer tutor={state} onStop={vi.fn()} />);
    await speak(/ask by voice/);
    expect(await screen.findByRole("alert")).toHaveTextContent("I didn't catch that");
    expect(state.ask).not.toHaveBeenCalled();
    await act(async () => { fireEvent.pointerDown(screen.getByRole("button", { name: /ask by voice/ }), { button: 0 }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone blocked: type instead.");
    expect(screen.getByRole("button", { name: /Microphone unavailable/ })).toBeDisabled();
    const box = screen.getByRole("textbox", { name: "Ask the tutor" });
    expect(box).toBeEnabled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(state.ask).toHaveBeenCalledWith("typed");
    // The notice gives way to captions once the learner moves on by typing; the mic stays blocked.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /Microphone unavailable/ })).toBeDisabled();
  });

  it("shows a live level meter on the mic while recording", async () => {
    voice.start.mockResolvedValue(recording());
    render(<TutorComposer tutor={tutor()} onStop={vi.fn()} />);
    expect(screen.queryByTestId("mic-level")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: /ask by voice/ }), { button: 0 });
    fireEvent.pointerUp(screen.getByRole("button", { name: /Recording|Listening/ }));
    const meter = await screen.findByTestId("mic-level");
    const bars = Array.from(meter.children) as HTMLElement[];
    expect(bars).toHaveLength(5);
    // The newest level (0.5) enters on the right.
    await waitFor(() => expect(bars[4].style.transform).toBe("scaleY(0.59)"));
  });

  it("does not send a recording that is too short, and shows Stop while the voice is still talking", async () => {
    voice.start.mockResolvedValue(recording(150));
    const onStop = vi.fn();
    render(<TutorComposer tutor={tutor({ narrating: true })} onStop={onStop} />);
    await speak(/ask by voice/);
    expect(await screen.findByRole("alert")).toHaveTextContent("Hold the mic while you speak");
    expect(voice.transcribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
  });
});
