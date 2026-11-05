import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiscoveryEnding from "./DiscoveryEnding";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
}));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

function motion(reduced: boolean) {
  window.matchMedia = vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
}
const created = () => (window.Image as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

describe("DiscoveryEnding", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the still mark, with no frames and no controls, for reduced motion", async () => {
    motion(true);
    vi.spyOn(window, "Image");
    vi.stubGlobal("IntersectionObserver", vi.fn());
    const { container } = render(<DiscoveryEnding />);
    await waitFor(() => expect(container.querySelector("img")?.parentElement?.style.opacity).toBe("1"));
    expect(created()).toBe(0);
    expect(IntersectionObserver).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("loads nothing until the section comes near, then starts when it is in view", () => {
    motion(false);
    vi.spyOn(window, "Image");
    const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; options: IntersectionObserverInit }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void, options: IntersectionObserverInit) { observers.push({ callback, options }); }
      observe() {} disconnect() {}
    });
    render(<DiscoveryEnding />);
    expect(created()).toBe(0);
    const near = observers.find((o) => o.options.rootMargin)!;
    near.callback([{ isIntersecting: false }]);
    expect(created()).toBe(0);
    near.callback([{ isIntersecting: true }]);
    expect(created()).toBeGreaterThan(0);
    expect(created()).toBeLessThanOrEqual(16); // a window ahead, never the whole set
  });

  it("links the credits the portrait licenses require", () => {
    motion(true);
    vi.stubGlobal("IntersectionObserver", vi.fn());
    render(<DiscoveryEnding />);
    expect(screen.getByRole("link", { name: "Portrait credits" }).getAttribute("href")).toBe("/credits");
  });
});
