"use client";

// Widgets live in Excalidraw embeddables with a `y-widget://` link and the validated spec in
// customData, so they pan, zoom, save and restore with the board. Excalidraw keeps an
// embeddable's pointer events off (until a center click activates it), so strokes reach the
// canvas. Only the widget's controls opt back in, and only while the selection tool is active:
// pen, eraser and shapes pass straight through, and the widget's background still selects and
// drags the element like any other.
import type { ExcalidrawEmbeddableElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import AttentionWidget from "./AttentionWidget";
import PlotWidget from "./PlotWidget";
import { WIDGET_SCHEME, parseWidget, type WidgetSpec } from "./widget-spec";

/** Our scheme validates; any other link falls through to Excalidraw's own allowlist. */
export function validateEmbeddable(link: string): boolean | undefined {
  return link.startsWith(WIDGET_SCHEME) ? true : undefined;
}

export function widgetOf(element: { link?: string | null; customData?: Record<string, unknown> }): WidgetSpec | null {
  if (!element.link?.startsWith(WIDGET_SCHEME)) return null;
  const stored = element.customData?.yWidget as { kind?: string; spec?: unknown } | undefined;
  return stored?.kind ? parseWidget(stored.kind, stored.spec) : null;
}

export function WidgetBody({ widget }: { widget: WidgetSpec }) {
  switch (widget.kind) {
    case "plot": return <PlotWidget spec={widget.spec} />;
    case "attention": return <AttentionWidget spec={widget.spec} />;
    default: return <div className="p-4 text-sm text-slate-500">This widget is not available yet.</div>;
  }
}

/** Controls take pointer input only with the selection tool; every other tool draws through. */
export const controlsLive = (appState: Pick<AppState, "activeTool">) => appState.activeTool.type === "selection";

export function renderEmbeddable(element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) {
  if (!element.link?.startsWith(WIDGET_SCHEME)) return null;
  const widget = widgetOf(element);
  return (
    <div className="y-widget h-full w-full overflow-hidden rounded-xl bg-white" data-widget={widget?.kind ?? "invalid"}
      data-live={controlsLive(appState) ? "true" : "false"}>
      {widget ? <WidgetBody widget={widget} /> : <div className="p-4 text-sm text-slate-500">This widget could not load.</div>}
    </div>
  );
}
