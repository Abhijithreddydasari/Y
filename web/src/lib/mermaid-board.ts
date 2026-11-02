// Mermaid → native Excalidraw skeletons, through the converter Excalidraw itself bundles
// (@excalidraw/mermaid-to-excalidraw, pinned to the version Excalidraw 0.18.1 depends on).
// Output is translated into the narration column, scaled down to fit, given unique ids and one
// group so the diagram moves as a unit. Mermaid runs in strict mode with plain-text labels.
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

export interface BoardDiagram { skeletons: ExcalidrawElementSkeleton[]; files: BinaryFiles; width: number; height: number }

const MIN_SCALE = 0.45;
const MIN_FONT = 14;
const SIDEWAYS = /^(\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\s+)(LR|RL)\b/;
const CONFIG = { securityLevel: "strict", htmlLabels: false, flowchart: { curve: "linear", htmlLabels: false },
  themeVariables: { fontSize: "16px" }, maxEdges: 60, maxTextSize: 4000 };
let counter = 0;

type Loose = Record<string, unknown> & { x?: number; y?: number; width?: number; height?: number };

function bounds(elements: Loose[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const x = el.x ?? 0, y = el.y ?? 0;
    const points = el.points as [number, number][] | undefined;
    const xs = points?.length ? points.map((p) => x + p[0]) : [x, x + (el.width ?? 0)];
    const ys = points?.length ? points.map((p) => y + p[1]) : [y, y + (el.height ?? 0)];
    minX = Math.min(minX, ...xs); maxX = Math.max(maxX, ...xs);
    minY = Math.min(minY, ...ys); maxY = Math.max(maxY, ...ys);
  }
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Place converted skeletons at `origin`, at most `maxWidth` wide. Pure; exported for tests. */
export function placeDiagram(elements: readonly ExcalidrawElementSkeleton[], origin: { x: number; y: number }, maxWidth: number,
  prefix: string): { skeletons: ExcalidrawElementSkeleton[]; width: number; height: number } {
  const loose = elements as unknown as Loose[];
  const box = bounds(loose);
  const scale = Math.max(MIN_SCALE, Math.min(1, maxWidth / box.width));
  const rename = (id: unknown) => (typeof id === "string" ? `${prefix}-${id}` : id);
  const group = `${prefix}-group`;
  const skeletons = loose.map((el) => {
    const out: Loose = { ...el, id: rename(el.id ?? `${counter++}`),
      x: origin.x + ((el.x ?? 0) - box.minX) * scale, y: origin.y + ((el.y ?? 0) - box.minY) * scale,
      groupIds: [...((el.groupIds as string[] | undefined) ?? []).map((g) => `${prefix}-${g}`), group],
      customData: { ...(el.customData as object | undefined), yDiagram: prefix } };
    if (el.width !== undefined) out.width = el.width * scale;
    if (el.height !== undefined) out.height = el.height * scale;
    if (Array.isArray(el.points)) out.points = (el.points as [number, number][]).map(([px, py]) => [px * scale, py * scale]);
    if (typeof el.fontSize === "number") out.fontSize = Math.max(MIN_FONT, el.fontSize * scale);
    if (el.label && typeof el.label === "object") {
      const label = el.label as Record<string, unknown>;
      out.label = { ...label, fontSize: Math.max(MIN_FONT, (typeof label.fontSize === "number" ? label.fontSize : 16) * scale) };
    }
    for (const key of ["start", "end"] as const) {
      const end = el[key] as Record<string, unknown> | undefined;
      if (end && typeof end === "object") out[key] = { ...end, ...(end.id ? { id: rename(end.id) } : {}) };
    }
    if (el.containerId) out.containerId = rename(el.containerId);
    if (Array.isArray(el.children)) out.children = (el.children as string[]).map((c) => rename(c));
    return out as unknown as ExcalidrawElementSkeleton;
  });
  return { skeletons, width: box.width * scale, height: box.height * scale };
}

/** Converts Mermaid source; throws if the converter rejects it (the caller falls back to text). */
export async function mermaidToBoard(source: string, origin: { x: number; y: number }, maxWidth: number): Promise<BoardDiagram> {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const parse = (text: string) => parseMermaidToExcalidraw(text, CONFIG as Parameters<typeof parseMermaidToExcalidraw>[1]);
  let result = await parse(source);
  if (!result.elements?.length) throw new Error("diagram produced no elements");
  // A long left-to-right chain would shrink below a readable size in the column: lay it out downwards.
  if (SIDEWAYS.test(source) && bounds(result.elements as unknown as Loose[]).width * 0.8 > maxWidth) {
    const upright = await parse(source.replace(SIDEWAYS, "$1TD")).catch(() => null);
    if (upright?.elements?.length) result = upright;
  }
  counter += 1;
  const placed = placeDiagram(result.elements, origin, maxWidth, `y-diagram-${Date.now().toString(36)}-${counter}`);
  return { ...placed, files: result.files ?? {} };
}

/** Labels from Mermaid source, for the text fallback when conversion fails. */
export function diagramLabels(source: string): string[] {
  const labels: string[] = [];
  for (const match of source.matchAll(/\[\s*"?([^\]"]+)"?\s*\]|\(\s*"?([^)"]+)"?\s*\)|\{\s*"?([^}"]+)"?\s*\}/g)) {
    const label = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.slice(0, 12);
}
