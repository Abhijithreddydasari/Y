import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatPanel from "./ChatPanel";

const baseProps = {
  busy: false,
  disabled: false,
  sttAvailable: false,
  onSend: vi.fn(),
  onClear: vi.fn(),
  onCancel: vi.fn(),
};

describe("ChatPanel", () => {
  it("opens from its orb and renders the whiteboard transcript as Markdown", () => {
    render(<ChatPanel {...baseProps} messages={[{
      id: "lesson-1",
      role: "assistant",
      source: "lesson",
      content: "## Integration\n\nIntegrate term by term.\n\n$$x^2 + C$$",
    }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open lesson chat" }));
    expect(screen.getByRole("heading", { name: "Integration" })).toBeInTheDocument();
    expect(screen.getByText("Integrate term by term.")).toBeInTheDocument();
    expect(screen.getByText("Whiteboard")).toBeInTheDocument();
  });

  it("sends typed follow-ups and explains unavailable local speech input", () => {
    const onSend = vi.fn();
    render(<ChatPanel {...baseProps} onSend={onSend} messages={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open lesson chat" }));
    const input = screen.getByRole("textbox", { name: "Chat message" });
    fireEvent.change(input, { target: { value: "Can you explain the second term?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Can you explain the second term?");
    expect(screen.getByRole("button", { name: "Speak message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Speak message" })).toHaveAttribute(
      "title", "Install local STT with: uv sync --extra stt",
    );
  });
});
