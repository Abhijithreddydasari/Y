import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LandingFrames from "./LandingFrames";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt, src, "aria-hidden": hidden }: { alt: string; src: string; "aria-hidden"?: boolean }) => <img alt={alt} src={src} aria-hidden={hidden} />,
}));

const pressed = () => screen.getAllByRole("button").find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;

function motion(reduced: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(window, "matchMedia", { value: window.matchMedia ?? globalThis.matchMedia, configurable: true, writable: true });
  window.matchMedia = globalThis.matchMedia;
}

describe("LandingFrames", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("advances through the frames and loops back to the start", () => {
    motion(false);
    render(<LandingFrames />);
    expect(pressed()).toContain("Ask");
    act(() => { vi.advanceTimersByTime(3_900); });
    expect(pressed()).toContain("Learn");
    act(() => { vi.advanceTimersByTime(3_800 * 3); });
    expect(pressed()).toContain("Ask");
  });

  it("stays on the first frame for people who prefer reduced motion", () => {
    motion(true);
    render(<LandingFrames />);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(pressed()).toContain("Ask");
  });

  it("holds the frame the learner chooses", () => {
    motion(false);
    render(<LandingFrames />);
    fireEvent.click(screen.getByRole("button", { name: /Check/ }));
    expect(pressed()).toContain("Check");
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(pressed()).toContain("Check");
    expect(screen.getByText("It checks what you understood before moving on.")).toBeTruthy();
  });

  it("pauses while the pointer is over it, then carries on", () => {
    motion(false);
    const { container } = render(<LandingFrames />);
    fireEvent.pointerEnter(container.firstElementChild!);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(pressed()).toContain("Ask");
    fireEvent.pointerLeave(container.firstElementChild!);
    act(() => { vi.advanceTimersByTime(3_900); });
    expect(pressed()).toContain("Learn");
  });

  it("describes only the visible frame to screen readers", () => {
    motion(false);
    render(<LandingFrames />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });
});
