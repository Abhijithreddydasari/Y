import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TutorPicker from "./TutorPicker";
import { loadPrefs, PREFS_KEY, resolvePrefs, savePrefs, type TutorOptions } from "@/lib/tutor-options";

const option = (id: string, label: string, extra: Partial<TutorOptions["models"][number]> = {}) =>
  ({ id, label, note: `${label} note`, default: false, available: true, reason: null, ...extra });
const options: TutorOptions = {
  models: [option("spark-1.3", "Muse Spark 1.3", { default: true }), option("spark-1.2", "Muse Spark 1.2"),
    option("spark-open", "Muse Spark Open", { available: false, reason: "Not configured on this server" })],
  voices: [option("kokoro_af_heart", "Heart", { default: true }), option("kokoro_am_michael", "Michael"),
    option("browser", "Browser voice"), option("off", "Off")],
};

afterEach(() => window.localStorage.clear());

describe("resolvePrefs", () => {
  it("keeps a stored choice that is still available", () => {
    expect(resolvePrefs(options, { model: "spark-1.2", voice: "off" })).toEqual({ model: "spark-1.2", voice: "off" });
  });

  it("falls back to the default when a stored or unknown option is unavailable", () => {
    expect(resolvePrefs(options, { model: "spark-open" }).model).toBe("spark-1.3");
    expect(resolvePrefs(options, { model: "gpt-9" }).model).toBe("spark-1.3");
    const noKokoro = { ...options, voices: options.voices.map((v) => v.id.startsWith("kokoro") ? { ...v, available: false } : v) };
    expect(resolvePrefs(noKokoro, { voice: "kokoro_am_michael" }).voice).toBe("browser");
    expect(resolvePrefs(noKokoro, {}).voice).toBe("browser");
  });

  it("round-trips through storage and survives garbage", () => {
    savePrefs({ model: "spark-1.2", voice: "browser" });
    expect(loadPrefs()).toEqual({ model: "spark-1.2", voice: "browser" });
    window.localStorage.setItem(PREFS_KEY, "{bad");
    expect(loadPrefs()).toEqual({});
  });
});

describe("TutorPicker", () => {
  it("shows the current choice, disables unavailable options with their reason and picks", () => {
    const onModel = vi.fn(), onVoice = vi.fn();
    render(<TutorPicker options={options} prefs={{ model: "spark-1.3", voice: "kokoro_af_heart" }} trace={null} onModel={onModel} onVoice={onVoice} />);
    const pill = screen.getByRole("button", { name: "Tutor Muse Spark 1.3, voice Heart" });
    expect(pill.textContent).toBe("Spark 1.3 · Heart");
    fireEvent.click(pill);
    expect(screen.getByRole("menu", { name: "Tutor and voice" })).toBeTruthy();
    const open = screen.getByRole("menuitemradio", { name: /Muse Spark Open/ });
    expect(open).toBeDisabled();
    expect(open.textContent).toContain("Not configured on this server");
    expect(screen.getByRole("menuitemradio", { name: /Muse Spark 1\.3/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Muse Spark 1\.2/ }));
    expect(onModel).toHaveBeenCalledWith("spark-1.2");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Browser voice/ }));
    expect(onVoice).toHaveBeenCalledWith("browser");
  });

  it("closes on Escape and names the model that answered last when it differs", () => {
    render(<TutorPicker options={options} prefs={{ model: "spark-1.2", voice: "off" }}
      trace={{ option: "spark-1.3", model: "muse-spark-1.3", effort: "minimal" }} onModel={vi.fn()} onVoice={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tutor Muse Spark 1.2, voice Off" }));
    expect(screen.getByText(/Last answer came from Muse Spark 1\.3/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows an icon-only trigger on narrow composers", () => {
    render(<TutorPicker compact options={options} prefs={{ model: "spark-1.3", voice: "off" }} trace={null} onModel={vi.fn()} onVoice={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Tutor Muse Spark 1.3, voice Off" });
    expect(trigger.textContent).toBe("");
  });

  it("renders nothing until the server lists options", () => {
    const { container } = render(<TutorPicker options={null} prefs={{ model: "spark-1.3", voice: "off" }} trace={null} onModel={vi.fn()} onVoice={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
