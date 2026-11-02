import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { controlsLive, renderEmbeddable, validateEmbeddable, widgetOf } from "./WidgetHost";
import { parseWidget, widgetSize, WIDGET_SCHEME } from "./widget-spec";
import PlotWidget from "./PlotWidget";
import AttentionWidget from "./AttentionWidget";

const plot = { expr: "a*sin(x)", x: [-3, 3], params: { a: { min: 0, max: 2, value: 1 } } };
const element = (customData: Record<string, unknown>, link = `${WIDGET_SCHEME}w1`) =>
  ({ id: "w1", type: "embeddable", link, customData }) as unknown as Parameters<typeof renderEmbeddable>[0];
const appState = (tool: string) => ({ activeTool: { type: tool } }) as unknown as Parameters<typeof renderEmbeddable>[1];

describe("parseWidget", () => {
  it("accepts the four contract kinds from a string or an object", () => {
    expect(parseWidget("plot", JSON.stringify(plot))?.kind).toBe("plot");
    expect(parseWidget("attention", { tokens: ["a", "b"], temp: 1 })?.kind).toBe("attention");
    expect(parseWidget("matrix", { m: [[1, 2], [3, 4]] })?.kind).toBe("matrix");
    expect(parseWidget("stepper", { steps: ["a", "b"] })?.kind).toBe("stepper");
  });

  it("rejects specs that would not render safely", () => {
    expect(parseWidget("plot", "{not json")).toBeNull();
    expect(parseWidget("plot", { ...plot, expr: "fetch(x)" })).toBeNull();
    expect(parseWidget("plot", { ...plot, expr: "a*b" })).toBeNull();
    expect(parseWidget("plot", { ...plot, x: [3, -3] })).toBeNull();
    expect(parseWidget("plot", { ...plot, params: { x: { min: 0, max: 1, value: 0.5 } } })).toBeNull();
    expect(parseWidget("plot", { ...plot, params: { a: { min: 0, max: 1, value: 2 } } })).toBeNull();
    expect(parseWidget("attention", { tokens: ["only"], temp: 1 })).toBeNull();
    expect(parseWidget("attention", { tokens: ["a", "b"], temp: 0 })).toBeNull();
    expect(parseWidget("matrix", { m: [[1, 2], [3]] })).toBeNull();
    expect(parseWidget("unknown", {})).toBeNull();
  });

  it("sizes widgets to fit the narration column", () => {
    for (const w of [parseWidget("plot", plot)!, parseWidget("attention", { tokens: Array(12).fill("tok"), temp: 1 })!]) {
      expect(widgetSize(w).width).toBeLessThanOrEqual(620);
    }
  });
});

describe("widget host", () => {
  it("validates only our scheme and defers other links to Excalidraw", () => {
    expect(validateEmbeddable(`${WIDGET_SCHEME}abc`)).toBe(true);
    expect(validateEmbeddable("https://youtube.com/watch?v=1")).toBeUndefined();
    expect(renderEmbeddable(element({}, "https://example.com"), appState("selection"))).toBeNull();
  });

  it("restores the widget from element data and gates controls by tool", () => {
    const el = element({ yWidget: { kind: "attention", spec: { tokens: ["the", "cat"], temp: 1 } } });
    expect(widgetOf(el)?.kind).toBe("attention");
    const { container, rerender } = render(renderEmbeddable(el, appState("selection"))!);
    expect(container.querySelector("[data-widget=attention]")?.getAttribute("data-live")).toBe("true");
    rerender(renderEmbeddable(el, appState("freedraw"))!);
    expect(container.querySelector("[data-widget=attention]")?.getAttribute("data-live")).toBe("false");
    expect(controlsLive({ activeTool: { type: "eraser" } } as never)).toBe(false);
  });

  it("shows a quiet placeholder for a corrupted spec", () => {
    render(renderEmbeddable(element({ yWidget: { kind: "plot", spec: { expr: "x" } } }), appState("selection"))!);
    expect(screen.getByText("This widget could not load.")).toBeTruthy();
  });
});

describe("widgets update locally", () => {
  it("plot slider redraws the curve", () => {
    render(<PlotWidget spec={plot as never} />);
    const path = () => screen.getByTestId("plot-path").getAttribute("d");
    const before = path();
    fireEvent.change(screen.getByLabelText("Parameter a"), { target: { value: "2" } });
    expect(path()).not.toBe(before);
    expect(screen.getByText("a = 2")).toBeTruthy();
  });

  it("attention temperature and query row change the weights", () => {
    render(<AttentionWidget spec={{ tokens: ["the", "cat", "sat"], temp: 1 }} />);
    const cell = () => Number(screen.getByTestId("cell-2-2").textContent);
    const warm = cell();
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "5" } });
    expect(cell()).not.toBe(warm);
    fireEvent.click(screen.getByTestId("cell-0-1"));
    expect(screen.getByText("the", { selector: "b" })).toBeTruthy();
  });
});
