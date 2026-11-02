// Client-side check of widget specs, mirroring PlotSpec/AttentionSpec/MatrixSpec/StepperSpec in
// api/learning/tutor_moves.py. The server already validated them; this guards restored boards and
// keeps a malformed spec from mounting.
import { compile } from "@/lib/expr";
import type { WidgetKind } from "@/lib/tutor-moves";

export const WIDGET_SCHEME = "y-widget://";

export interface Param { min: number; max: number; value: number }
export interface PlotSpec { expr: string; x: [number, number]; params: Record<string, Param> }
export interface AttentionSpec { tokens: string[]; temp: number }
export interface MatrixSpec { m: number[][] }
export interface StepperSpec { steps: string[] }
export type WidgetSpec =
  | { kind: "plot"; spec: PlotSpec }
  | { kind: "attention"; spec: AttentionSpec }
  | { kind: "matrix"; spec: MatrixSpec }
  | { kind: "stepper"; spec: StepperSpec };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The parsed spec, or null if it would not render safely. */
export function parseWidget(kind: WidgetKind | string, raw: string | unknown): WidgetSpec | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!isObject(value)) return null;
  if (kind === "plot") {
    const { expr, x, params } = value;
    if (typeof expr !== "string" || !Array.isArray(x) || x.length !== 2 || !finite(x[0]) || !finite(x[1]) || x[0] >= x[1]) return null;
    if (!isObject(params) || Object.keys(params).length > 6) return null;
    const clean: Record<string, Param> = {};
    for (const [name, p] of Object.entries(params)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(name) || name === "x" || !isObject(p)) return null;
      const { min, max, value: v } = p;
      if (!finite(min) || !finite(max) || !finite(v) || min === max || v < min || v > max) return null;
      clean[name] = { min, max, value: v };
    }
    try { compile(expr, ["x", ...Object.keys(clean)]); } catch { return null; }
    return { kind, spec: { expr, x: [x[0], x[1]], params: clean } };
  }
  if (kind === "attention") {
    const { tokens, temp } = value;
    if (!Array.isArray(tokens) || tokens.length < 2 || tokens.length > 12) return null;
    if (!tokens.every((t) => typeof t === "string" && t.length >= 1 && t.length <= 24) || !finite(temp) || temp <= 0 || temp > 100) return null;
    return { kind, spec: { tokens: tokens as string[], temp } };
  }
  if (kind === "matrix") {
    const { m } = value;
    if (!Array.isArray(m) || m.length < 1 || m.length > 6) return null;
    const width = Array.isArray(m[0]) ? m[0].length : 0;
    if (width < 1 || width > 6 || !m.every((row) => Array.isArray(row) && row.length === width && row.every(finite))) return null;
    return { kind, spec: { m: m as number[][] } };
  }
  if (kind === "stepper") {
    const { steps } = value;
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 12) return null;
    if (!steps.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 600)) return null;
    return { kind, spec: { steps: steps as string[] } };
  }
  return null;
}

/** Board size of a widget in scene pixels. */
export function widgetSize(widget: WidgetSpec): { width: number; height: number } {
  switch (widget.kind) {
    case "plot": return { width: 520, height: 300 + 34 * Object.keys(widget.spec.params).length };
    case "attention": return { width: 560, height: 190 + 30 * widget.spec.tokens.length };
    case "matrix": return widget.spec.m.length === 2 && widget.spec.m[0].length === 2 ? { width: 500, height: 250 }
      : { width: 120 + 60 * widget.spec.m[0].length, height: 110 + 40 * widget.spec.m.length };
    case "stepper": return { width: 560, height: 210 };
  }
}
