import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MindOverlay from "./MindOverlay";

vi.mock("./MindScene", () => ({ default: () => <div data-testid="scene" /> }));

function stillMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true, configurable: true,
    value: (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }),
  });
}

const REV = {
  schema_version: 1, revision: 1, parent_revision: null, session_id: "11111111-1111-4111-8111-111111111111",
  observation_ids: ["a0000000-0000-4000-8000-000000000000"], consolidator: null, created_at: "2026-11-03T10:00:00Z",
  beliefs: [{ concept: "attention.softmax", dimension: "understand", alpha: 3, beta: 1.5, half_life_hours: 24, last_evidence_at: "2026-11-03T10:00:00Z" }],
  misconceptions: [{ id: "attention.softmax/belief-x", concept: "attention.softmax", description: "On attention.softmax: thinks weights are equal", status: "active", strength: 0.8, evidence: ["a0000000-0000-4000-8000-000000000000"] }],
  notes: [{ text: "Confront the equal-weights idea from a0000000-0000-4000-8000-000000000000 with two tokens.", cites: ["a0000000-0000-4000-8000-000000000000"] }],
  links: [],
};
const HISTORY = { revisions: [REV], events: [{ id: "a0000000-0000-4000-8000-000000000000", concept: "attention.softmax", dimension: "understand",
  outcome: "incorrect", modality: "tap", created_at: "2026-11-03T09:00:00Z", question: "What does softmax do to scores?", answer: "makes them equal" }] };

function serve(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe("MindOverlay", () => {
  it("renders the still SVG map, not the 3D scene, under reduced motion and opens the evidence sheet", async () => {
    stillMotion(true);
    serve(HISTORY);
    render(<MindOverlay onClose={() => {}} />);
    const neuron = await screen.findByRole("button", { name: "Softmax" });
    expect(screen.getByRole("group", { name: "Mind, still view" })).toBeInTheDocument();
    expect(screen.queryByTestId("scene")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
    expect(screen.queryByText(/Replay session/)).toBeNull();
    fireEvent.click(neuron);
    const sheet = await screen.findByRole("complementary", { name: "Softmax evidence" });
    expect(sheet).toHaveTextContent("Misconception: thinks weights are equal");
    expect(sheet).toHaveTextContent("Confront the equal-weights idea from that answer with two tokens.");
    expect(sheet).toHaveTextContent("“makes them equal” — incorrect");
  });

  it("loads the 3D scene when motion is allowed", async () => {
    stillMotion(false);
    const canvas = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof canvas;
    serve(HISTORY);
    render(<MindOverlay onClose={() => {}} />);
    expect(await screen.findByTestId("scene")).toBeInTheDocument();
    HTMLCanvasElement.prototype.getContext = canvas;
  });

  it("labels the sample when the profile is empty and offers Retry on failure", async () => {
    stillMotion(true);
    serve({ revisions: [], events: [] });
    const { unmount } = render(<MindOverlay onClose={() => {}} />);
    expect(await screen.findByText("Sample")).toBeInTheDocument();
    unmount();
    vi.restoreAllMocks();
    const failing = serve({ detail: "down" }, 503);
    render(<MindOverlay onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Sample")).toBeNull();
  });

  it("switches between the night and paper themes and remembers the choice", async () => {
    stillMotion(true);
    serve(HISTORY);
    render(<MindOverlay onClose={() => {}} />);
    await screen.findByRole("button", { name: "Softmax" });
    const dialog = screen.getByRole("dialog", { name: "Mind" });
    expect(dialog).toHaveAttribute("data-theme", "dark");
    fireEvent.click(screen.getByRole("button", { name: "Switch to light (paper) theme" }));
    expect(dialog).toHaveAttribute("data-theme", "light");
    expect(dialog.style.getPropertyValue("--mind-bg")).toBe("#F7F1E3");
    expect(screen.getByRole("group", { name: "Mind, still view" }).querySelector("rect")).toHaveAttribute("fill", "#F7F1E3");
    expect(localStorage.getItem("y_mind_theme")).toBe("light");
  });

  it("counts neurons by state in chips that filter the map, with the rarer marks behind the ?", async () => {
    stillMotion(true);
    serve(HISTORY);
    render(<MindOverlay onClose={() => {}} />);
    const neuron = await screen.findByRole("button", { name: "Softmax" });
    const wrong = screen.getByRole("button", { name: "Wrong belief 1" });
    expect(screen.getByRole("button", { name: "Solid 0" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Solid 0" }));
    expect(neuron).toHaveAttribute("opacity", "0.14");
    fireEvent.click(wrong);
    expect(wrong).toHaveAttribute("aria-pressed", "true");
    expect(neuron).toHaveAttribute("opacity", "1");
    expect(screen.queryByRole("group", { name: "What the other marks mean" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What the other marks mean" }));
    expect(screen.getByRole("group", { name: "What the other marks mean" })).toHaveTextContent("Gold ring: wrong belief fixed");
  });

  it("finds a concept, and Escape clears the search before it closes the map", async () => {
    stillMotion(true);
    serve(HISTORY);
    const onClose = vi.fn();
    render(<MindOverlay onClose={onClose} />);
    const neuron = await screen.findByRole("button", { name: "Softmax" });
    const search = screen.getByRole("textbox", { name: "Find a concept" });
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(neuron).toHaveAttribute("opacity", "0.14");
    fireEvent.change(search, { target: { value: "SOFT" } });
    expect(neuron).toHaveAttribute("opacity", "1");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("explains a state in plain words, offers what changed, and has no full-screen button", async () => {
    stillMotion(true);
    serve(HISTORY);
    render(<MindOverlay onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Softmax" }));
    expect(await screen.findByRole("complementary", { name: "Softmax evidence" })).toHaveTextContent("A wrong idea keeps showing up in the answers here.");
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
    const changed = screen.getByRole("button", { name: /changed last session/ });
    fireEvent.click(changed);
    expect(changed).toHaveAttribute("aria-pressed", "true");
  });

  it("closes on Escape", async () => {
    stillMotion(true);
    serve(HISTORY);
    const onClose = vi.fn();
    render(<MindOverlay onClose={onClose} />);
    await screen.findByRole("button", { name: "Softmax" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
