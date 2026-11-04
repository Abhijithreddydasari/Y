import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasDialog } from "./CanvasList";

vi.mock("@/lib/board-api", async (original) => ({ ...await original<object>(), boardSession: vi.fn().mockResolvedValue("sid") }));
vi.mock("@/lib/tutor-turn", async (original) => ({ ...await original<object>(), fetchCanvases: vi.fn().mockResolvedValue([
  { session_id: "sid", title: "Can you explain me rotary position encodings or RoPE with the help of a diagram", created_at: 1_793_800_000, turns: 4, sealed: false },
]) }));

describe("CanvasDialog", () => {
  it("clamps a long title to its header and keeps the full text as a tooltip", async () => {
    render(<CanvasDialog onClose={() => {}} />);
    const title = await screen.findByTestId("canvas-title");
    expect(title).toHaveClass("line-clamp-3");
    expect(title).not.toHaveClass("block"); // `block` would override the clamp's own display
    expect(title).toHaveAttribute("title", "Can you explain me rotary position encodings or RoPE with the help of a diagram");
  });
});
