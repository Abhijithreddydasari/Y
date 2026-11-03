import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolDock from "@/components/ToolDock";
import type { TutorTurnState } from "@/hooks/useTutorSession";
import type { TutorSession } from "@/hooks/useTutorSession";
import { toolOf, toolSettings } from "@/lib/board-tools";
import RadialMenu, { arcPoint } from "./RadialMenu";
import ReviewSheet from "./ReviewSheet";
import SettingsSheet from "./SettingsSheet";

afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.toolDock; });

describe("RadialMenu", () => {
  it("fans items along the arc, opens and closes, and closes on pick, Escape and outside press", () => {
    expect(arcPoint(0, 3, 180, 270, 100)).toMatchObject({ x: -100, y: 0 });
    expect(arcPoint(2, 3, 180, 270, 100)).toMatchObject({ x: 0, y: -100 });
    const onSelect = vi.fn(), onOpenChange = vi.fn();
    const items = [{ id: "a", label: "Mind", icon: "M0 0", onSelect }, { id: "b", label: "Trace", icon: "M0 0", onSelect: vi.fn(), disabled: true }];
    const { rerender } = render(<RadialMenu items={items} open={false} onOpenChange={onOpenChange} from={180} to={270} label="Places" button="Y" />);
    expect(screen.getByRole("menuitem", { name: "Mind", hidden: true })).toHaveAttribute("tabindex", "-1");
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    rerender(<RadialMenu items={items} open onOpenChange={onOpenChange} from={180} to={270} label="Places" button="Y" />);
    expect(screen.getByRole("menuitem", { name: "Trace" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mind" }));
    expect(onSelect).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledTimes(3);
  });
});

const tutor = (over: Partial<TutorTurnState> = {}) => ({
  busy: false, sealed: false, question: null, memory: { on: true, set: vi.fn(), turn: null },
  warmup: { items: [{ concept: "transformer.ffn-role", reason: "misconception" as const, q: "What does the FFN do?", retention: 0.4, mean: 0.3 }],
    visible: true, started: false, start: vi.fn(), skip: vi.fn() },
  ...over,
}) as unknown as TutorTurnState;

describe("ReviewSheet", () => {
  it("lists due checks with their reason and starts the warm-up", () => {
    const state = tutor(), onClose = vi.fn();
    render(<ReviewSheet tutor={state} onClose={onClose} />);
    expect(screen.getByTestId("review-items")).toHaveTextContent("Misconception");
    expect(screen.getByTestId("review-items")).toHaveTextContent("FFN role");
    fireEvent.click(screen.getByRole("button", { name: /Start warm-up · 1 check/ }));
    expect(state.warmup.start).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("waits for the open card and says when nothing is due", () => {
    const { rerender } = render(<ReviewSheet tutor={tutor({ question: { qid: "q", kind: "mcq", q: "?", options: [] } })} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Start warm-up/ })).toBeDisabled();
    rerender(<ReviewSheet tutor={tutor({ warmup: { items: [], visible: false, started: false, start: vi.fn(), skip: vi.fn() } })} onClose={vi.fn()} />);
    expect(screen.getByText(/Nothing is due/)).toBeInTheDocument();
  });
});

describe("SettingsSheet", () => {
  it("switches memory, narration, layout and Classic tools", () => {
    const state = tutor();
    const session = { tutor: state, ttsEnabled: true, toggleTts: vi.fn() } as unknown as TutorSession;
    const mode = { mode: "studio", setMode: vi.fn(), useAutomaticMode: vi.fn() };
    render(<SettingsSheet session={session} interfaceMode={mode as never} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Memory" }));
    expect(state.memory.set).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("switch", { name: "Narration" }));
    expect(session.toggleTts).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "mobile" }));
    expect(mode.setMode).toHaveBeenCalledWith("mobile");
    const classic = screen.getByRole("switch", { name: "Classic tools" });
    expect(classic).not.toBeChecked();
    fireEvent.click(classic);
    expect(classic).toBeChecked();
    expect(localStorage.getItem("y_classic_tools_v1")).toBe("1");
  });
});

describe("Tool dock", () => {
  it("maps dock tools onto Excalidraw tools and back", () => {
    expect(toolSettings("pen", "#1d4ed8")).toEqual({ type: "freedraw", style: { currentItemStrokeColor: "#1d4ed8", currentItemOpacity: 100, currentItemStrokeWidth: 2 } });
    expect(toolSettings("highlighter", "#000").style).toMatchObject({ currentItemOpacity: 40 });
    expect(toolSettings("eraser", "#000")).toEqual({ type: "eraser", style: undefined });
    expect(toolOf("freedraw", 40)).toBe("highlighter");
    expect(toolOf("freedraw", 100)).toBe("pen");
    expect(toolOf("laser", 100)).toBeNull();
  });

  it("hides Excalidraw's toolbar while mounted, drives the board and follows shortcuts", () => {
    let follow: (tool: string | null) => void = () => {};
    const board = { setTool: vi.fn(), onToolChange: vi.fn((listener) => { follow = listener; return () => {}; }) };
    const { unmount } = render(<ToolDock board={board as never} />);
    expect(document.documentElement.dataset.toolDock).toBe("on");
    fireEvent.click(screen.getByRole("button", { name: "Pen (P)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#1e1e1e");
    fireEvent.click(screen.getByRole("button", { name: "Blue ink" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#1d4ed8");
    act(() => follow("eraser"));
    expect(screen.getByRole("button", { name: "Eraser (E)" })).toHaveAttribute("aria-pressed", "true");
    unmount();
    expect(document.documentElement.dataset.toolDock).toBeUndefined();
  });
});
