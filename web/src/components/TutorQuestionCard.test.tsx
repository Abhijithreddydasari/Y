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

describe("TutorQuestionCard placement", () => {
  const rectAt = (top: number) => new DOMRect(100, top, 300, 60);

  it("sits under its board card when there is room", async () => {
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => rectAt(80)} onAnswer={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("tutor-question")).toHaveStyle({ top: "148px", left: "100px" }));
  });

  it("brings a new question into view once, then becomes a pill when the learner scrolls it away", async () => {
    const onReveal = vi.fn();
    let top = 700;
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => rectAt(top)} onAnswer={vi.fn()} onReveal={onReveal} />);
    expect(onReveal).not.toHaveBeenCalled(); // waits for the lesson's own closing scroll
    expect(screen.queryByTestId("tutor-question")).toBeNull();
    await waitFor(() => expect(onReveal).toHaveBeenCalledWith("t.3"));
    top = 80;
    await waitFor(() => expect(screen.getByTestId("tutor-question")).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 200));
    top = 2000; // scrolled up: the card must not jump over the lesson
    expect(await screen.findByTestId("question-pill")).toBeInTheDocument();
    expect(screen.queryByTestId("tutor-question")).toBeNull();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("closes to a pill that keeps the answer in progress, and Back to it reopens", async () => {
    const onReveal = vi.fn();
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => rectAt(80)} onAnswer={vi.fn()} onReveal={onReveal} />);
    fireEvent.click(await screen.findByRole("button", { name: /the mean/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close question" }));
    expect(screen.queryByTestId("tutor-question")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to it" }));
    expect(onReveal).toHaveBeenCalledWith("t.3");
    expect(screen.getByRole("button", { name: /the mean/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("stays docked with the question text when no card is on the board", async () => {
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(mcq.q)).toBeInTheDocument();
    expect(screen.queryByTestId("question-pill")).toBeNull();
  });
});

describe("TutorQuestionCard", () => {
  it("submits the chosen option with confidence and offers just tell me", () => {
    const onAnswer = vi.fn();
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={onAnswer} />);
    expect(screen.getByText(mcq.q)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /the mean/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Certain" }));
    expect(screen.getByRole("radio", { name: "Certain" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith({ choice: "the mean", confidence: 95 });
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
    setDraft: vi.fn(), ask: vi.fn(), answer: vi.fn(), cardRect: () => null, revealCard: vi.fn(), hush: vi.fn(),
    picker: { options: null, prefs: { model: "spark-1.3", voice: "kokoro_af_heart" }, trace: null, setModel: vi.fn(), setVoice: vi.fn() },
    memory: { on: true, set: vi.fn(), turn: null }, endSession: vi.fn(), ending: false, saveTo: { value: null, set: vi.fn() },
    warmup: { items: [], visible: false, started: false, start: vi.fn(), skip: vi.fn() },
    exit: { offered: false, take: vi.fn(), skip: vi.fn() },
    hints: { given: [], busy: false, next: vi.fn() }, sealed: false, newSession: vi.fn(),
    ...overrides };
}

describe("Study loop (H7)", () => {
  const due = { concept: "attention.softmax", reason: "misconception" as const, q: "What does softmax do?", retention: 1, mean: 0.4 };

  it("offers a warm-up that can be started or skipped and hides it while a card waits", () => {
    const state = tutor({ warmup: { items: [due], visible: true, started: false, start: vi.fn(), skip: vi.fn() } });
    const { rerender } = render(<TutorComposer tutor={state} onStop={vi.fn()} />);
    expect(screen.getByTestId("warmup")).toHaveTextContent("Warm-up · 1 due from last time");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(state.warmup.start).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(state.warmup.skip).toHaveBeenCalled();
    rerender(<TutorComposer tutor={{ ...state, question: mcq }} onStop={vi.fn()} />);
    expect(screen.queryByTestId("warmup")).toBeNull();
    // Asking stays possible whatever the warm-up shows.
    expect(screen.getByRole("textbox", { name: "Ask the tutor" })).not.toBeDisabled();
  });

  it("shows the shaking bulb only while thinking", () => {
    const { rerender } = render(<TutorComposer tutor={tutor()} onStop={vi.fn()} status="Thinking…" />);
    expect(screen.getByTestId("thinking-bulb")).toHaveClass("y-thinking-bulb");
    rerender(<TutorComposer tutor={tutor()} onStop={vi.fn()} status="Explaining…" />);
    expect(screen.queryByTestId("thinking-bulb")).toBeNull();
    rerender(<TutorComposer tutor={tutor({ error: "The tutor is busy." })} onStop={vi.fn()} status="Thinking…" />);
    expect(screen.queryByTestId("thinking-bulb")).toBeNull();
  });

  it("offers the exit ticket or a plain end", () => {
    const state = tutor({ exit: { offered: true, take: vi.fn(), skip: vi.fn() } });
    render(<TutorComposer tutor={state} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Take it" }));
    expect(state.exit.take).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Just end" }));
    expect(state.exit.skip).toHaveBeenCalled();
  });

  it("explains a sealed canvas and offers a new session", () => {
    const state = tutor({ sealed: true });
    render(<TutorComposer tutor={state} onStop={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Ask the tutor" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Ask the tutor" })).toHaveAttribute("placeholder", "This canvas is sealed. Start a new session to ask.");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(state.newSession).toHaveBeenCalled();
  });

  it("climbs the hint ladder on the card, then leaves the reveal to Just tell me", () => {
    const onHint = vi.fn();
    const { rerender } = render(<TutorQuestionCard question={{ ...mcq, origin: "review" }} busy={false} cardRect={() => null}
      onAnswer={vi.fn()} hints={[]} onHint={onHint} />);
    expect(screen.getByText("Warm-up from last time")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hint" }));
    expect(onHint).toHaveBeenCalledTimes(1);
    rerender(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={vi.fn()} onHint={onHint}
      hints={[{ level: 1, text: "Look at the exponent." }]} />);
    expect(screen.getByTestId("hints")).toHaveTextContent("Nudge:Look at the exponent.");
    fireEvent.click(screen.getByRole("button", { name: "Show a step" }));
    rerender(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={vi.fn()} onHint={onHint}
      hints={[{ level: 1, text: "Look at the exponent." }, { level: 2, text: "e^2 is about 7.4." }]} />);
    expect(screen.queryByRole("button", { name: /Hint|Show a step/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Just tell me" })).toBeInTheDocument();
  });

  it("labels the answer choices and typesets inline math in a nudge", () => {
    render(<TutorQuestionCard question={mcq} busy={false} cardRect={() => null} onAnswer={vi.fn()}
      hints={[{ level: 1, text: "Each piece $dq = \\sigma dA$ adds $dq / r$." }]} />);
    expect(screen.getByText("Answer choices")).toBeInTheDocument();
    const hint = screen.getByTestId("hints");
    expect(hint.querySelectorAll(".katex")).toHaveLength(2);
    expect(hint.textContent).not.toContain("$");
  });
});

describe("Memory in the composer", () => {
  it("shows what the brief contributed, and nothing with Memory off", () => {
    const state = tutor({ memory: { on: true, set: vi.fn(), turn: { on: true, revision: 1,
      items: [{ id: "M1", kind: "misconception", text: "On attention.scaling: believes the mean" }] } } });
    const { rerender } = render(<TutorComposer tutor={state} onStop={vi.fn()} status="Thinking…" />);
    expect(screen.getByTestId("memory-used")).toHaveTextContent("Using 1 item from earlier sessions");
    // The switch and End session moved to Settings and the Places arc.
    expect(screen.queryByRole("switch", { name: "Memory" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
    rerender(<TutorComposer tutor={tutor({ memory: { on: false, set: vi.fn(), turn: { on: false, revision: null, items: [] } } })} onStop={vi.fn()} />);
    expect(screen.queryByTestId("memory-used")).toBeNull();
  });
});

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
