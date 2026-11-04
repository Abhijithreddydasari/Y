import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToolDock from "@/components/ToolDock";
import type { TutorTurnState } from "@/hooks/useTutorSession";
import type { TutorSession } from "@/hooks/useTutorSession";
import { toolOf, toolSettings, forgetToolMemory } from "@/lib/board-tools";
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

describe("Try as… (demo personas)", () => {
  const listing = { active: "priya", personas: [
    { key: "priya", name: "Priya Nair", blurb: "MSc ML student", topics: ["KV cache"], copied: true },
    { key: "amara", name: "Amara Okafor", blurb: "Physics PhD student", topics: [], copied: false }] };

  it("marks the active learner, switches profile and picks the mind End session saves to", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(listing), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const state = tutor({ saveTo: { value: null, set: vi.fn() } } as never);
    const session = { tutor: state, ttsEnabled: true, toggleTts: vi.fn() } as unknown as TutorSession;
    render(<SettingsSheet session={session} interfaceMode={{ mode: "studio", setMode: vi.fn(), useAutomaticMode: vi.fn() } as never}
      onClose={vi.fn()} personas={{ listing, error: "" }} />);
    expect(screen.getByRole("radio", { name: /Priya Nair/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Reset Priya" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "End session saves to" }), { target: { value: "own" } });
    expect(state.saveTo.set).toHaveBeenCalledWith({ into: "own", name: "your own mind" });
    fireEvent.click(screen.getByRole("radio", { name: /Your own/ }));
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/learning/personas/active", expect.objectContaining({ method: "PUT", body: JSON.stringify({ persona: null }) }));
    expect(localStorage.getItem("y_profile_v1")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps one board session per profile", async () => {
    const { sessionKey, setProfileKey } = await import("@/lib/personas");
    expect(sessionKey(null)).toBe("y_board_session_v1");
    setProfileKey("tomas");
    expect(sessionKey()).toBe("y_board_session_v1:tomas");
    setProfileKey(null);
    expect(sessionKey()).toBe("y_board_session_v1");
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

  const dockBoard = () => {
    const board = {
      follow: (() => {}) as (tool: string | null) => void,
      styled: (() => {}) as (tool: string | null, color: string, width: number) => void,
      setTool: vi.fn(), setStyle: vi.fn(),
      onToolChange: vi.fn((listener) => { board.follow = listener; return () => {}; }),
      onStyleChange: vi.fn((listener) => { board.styled = listener; return () => {}; }),
    };
    return board;
  };

  beforeEach(() => { localStorage.removeItem("y_tool_memory_v1"); forgetToolMemory(); });

  it("hides Excalidraw's toolbar while mounted, drives the board and follows shortcuts", () => {
    const board = dockBoard();
    const { unmount } = render(<ToolDock board={board as never} />);
    expect(document.documentElement.dataset.toolDock).toBe("on");
    fireEvent.click(screen.getByRole("button", { name: "Pen (P)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#1e1e1e", 2);
    fireEvent.click(screen.getByRole("button", { name: "Blue ink" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#1d4ed8", 2);
    act(() => board.follow("eraser"));
    expect(screen.getByRole("button", { name: "Eraser (E)" })).toHaveAttribute("aria-pressed", "true");
    unmount();
    expect(document.documentElement.dataset.toolDock).toBeUndefined();
  });

  it("keeps colour and thickness through other tools and a reload", () => {
    const board = dockBoard();
    const { unmount } = render(<ToolDock board={board as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Red ink" }));
    fireEvent.click(screen.getByRole("button", { name: "Thick line" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#dc2626", 4);
    fireEvent.click(screen.getByRole("button", { name: "Eraser (E)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("eraser", "#dc2626", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Highlighter" }));
    expect(board.setTool).toHaveBeenLastCalledWith("highlighter", "#dc2626", 4);
    fireEvent.click(screen.getByRole("button", { name: "Pen (P)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#dc2626", 4);
    unmount();

    forgetToolMemory(); // a reload: only storage is left
    const next = dockBoard();
    render(<ToolDock board={next as never} />);
    expect(next.setStyle).toHaveBeenCalledWith("#dc2626", 4);
    fireEvent.click(screen.getByRole("button", { name: "Pen (P)" }));
    expect(next.setTool).toHaveBeenLastCalledWith("pen", "#dc2626", 4);
  });

  it("remembers a style chosen in Excalidraw's own panel, per tool", () => {
    const board = dockBoard();
    render(<ToolDock board={board as never} />);
    act(() => board.styled("pen", "#123456", 1));
    fireEvent.click(screen.getByRole("button", { name: "Arrow (A)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("arrow", "#123456", 2);
    fireEvent.click(screen.getByRole("button", { name: "Pen (P)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#123456", 1);
    act(() => board.styled("highlighter", "#00ff00", 2));
    fireEvent.click(screen.getByRole("button", { name: "Pen (P)" }));
    expect(board.setTool).toHaveBeenLastCalledWith("pen", "#123456", 1); // the highlighter's colour stays its own
  });
});
