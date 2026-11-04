// Tutor move contract mirrored from api/learning/tutor_moves.py; the strict JSON schema lives in
// schema/tutor-moves.v1.json. Moves reaching the browser have passed server-side validation.
import type { LearningDimension } from "./learner-contracts";

export const MOVES_SCHEMA_VERSION = "tutor-moves.v1";
export const MOVE_KINDS = ["seg", "write", "equation", "diagram", "widget", "image", "say", "predict", "check",
  "because", "point", "turn_end"] as const;
export const WIDGET_KINDS = ["plot", "attention", "matrix", "stepper"] as const;
export type MoveKind = typeof MOVE_KINDS[number];
export type WidgetKind = typeof WIDGET_KINDS[number];

export type TutorMove =
  | { type: "seg"; id: string; goal: string }
  | { type: "write"; text: string }
  | { type: "equation"; latex: string }
  | { type: "diagram"; mermaid: string }
  | { type: "widget"; kind: WidgetKind; spec: string }
  | { type: "image"; prompt: string; alt: string }
  | { type: "say"; text: string }
  | { type: "predict"; q: string; options: string[]; answer: string }
  | { type: "check"; kind: "mcq" | "free"; q: string; key: string; concept: string; dim: LearningDimension; options: string[] }
  | { type: "because"; refs: string[]; text: string }
  /** x/y are 0–1000 within crop `crop`; line is 1-based in the learner's work, 0 if unknown. */
  | { type: "point"; crop: number; x: number; y: number; line: number; label: string }
  | { type: "turn_end"; reason: "wait" | "done" };
export type MoveOf<K extends MoveKind> = Extract<TutorMove, { type: K }>;

/** Property order of every move, as in the strict schema (kept in sync by tests). */
export const MOVE_FIELDS: { [K in MoveKind]: readonly (keyof MoveOf<K>)[] } = {
  seg: ["type", "id", "goal"],
  write: ["type", "text"],
  equation: ["type", "latex"],
  diagram: ["type", "mermaid"],
  widget: ["type", "kind", "spec"],
  image: ["type", "prompt", "alt"],
  say: ["type", "text"],
  predict: ["type", "q", "options", "answer"],
  check: ["type", "kind", "q", "key", "concept", "dim", "options"],
  because: ["type", "refs", "text"],
  point: ["type", "crop", "x", "y", "line", "label"],
  turn_end: ["type", "reason"],
};

// Widgets compute derived values (attention scores, eigenvalues) themselves.
export interface PlotSpec { expr: string; x: [number, number]; params: Record<string, { min: number; max: number; value: number }>; xLabel?: string; yLabel?: string }
export interface AttentionSpec { tokens: string[]; temp: number }
export interface MatrixSpec { m: number[][] }
export interface StepperSpec { steps: string[] }
export interface WidgetSpecs { plot: PlotSpec; attention: AttentionSpec; matrix: MatrixSpec; stepper: StepperSpec }

export function widgetSpec<K extends WidgetKind>(move: MoveOf<"widget"> & { kind: K }): WidgetSpecs[K] {
  return JSON.parse(move.spec) as WidgetSpecs[K];
}

/** Predict and check moves ask the learner something; a turn ending in one waits for the answer. */
export const isQuestion = (move: TutorMove): move is MoveOf<"predict"> | MoveOf<"check"> =>
  move.type === "predict" || move.type === "check";
