// The trace drawer's data: which model did each stage of this session, and how long it took.
// Read from GET …/trace, which serves only timings the stages already stored (no prompts or keys).
import type { TutorTrace } from "./tutor-options";
import type { TutorTimeline } from "./tutor-turn";

type Usage = Partial<Record<"input_tokens" | "cached_tokens" | "output_tokens" | "reasoning_tokens", number>>;
export interface TraceTurn {
  stage: "turn"; seq: number; kind: string; status: string; at: number | null; goal: string; tutor: TutorTrace | null;
  ms: Partial<Record<"context_ms" | "headers_ms" | "first_token_ms" | "first_move_ms" | "stream_ms" | "total_ms", number>>;
  usage: Usage; moves: number; dropped: number; repairs: number; error: string | null; model_call: boolean; seed?: boolean;
  points: { snap: string | null; line: number; lines: number | null }[];
}
export interface TraceHint { stage: "hint"; qid: string; level: number; at: number | null; ms: number | null; tutor: TutorTrace | null; usage: Usage }
export interface TraceLabel {
  stage: "label"; qid: string; status: string; error: string | null; labeler: string | null; model: string | null;
  verifier: string | null; modality: string | null; images: number | null; ms: Partial<Record<"label_ms" | "provider_ms" | "queue_ms", number>>;
}
export interface TraceClose {
  stage: "close"; revision: number | null; ms: number | null; sealed: number | null; notes_model: string;
  notes: { kept?: number; dropped?: unknown[]; named?: string[]; links?: number; error?: string }; relabel: { requeued?: number } | null;
  /** Seeded demo-persona history: no model ran at this close. */
  seed?: boolean;
}
export interface SessionTrace { turns: TraceTurn[]; hints: TraceHint[]; labels: TraceLabel[]; close: TraceClose | null }

export async function fetchTrace(session: string, signal?: AbortSignal): Promise<SessionTrace> {
  const response = await fetch(`/api/learning/sessions/${session}/trace`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error(`trace ${response.status}`);
  return response.json() as Promise<SessionTrace>;
}

const NAMES: [RegExp, string][] = [
  [/muse-spark-open/, "Muse Spark Open"], [/muse-spark-1\.3/, "Muse Spark 1.3"], [/muse-spark-1\.2/, "Muse Spark 1.2"],
  [/muse-spark-1\.1/, "Muse Spark 1.1"], [/muse-image/, "Muse Image"], [/gpt-6-luna/, "OpenAI Decisions"], [/elephant/, "Baseten Elephant"],
];

/** A judge-readable model name: "Muse Spark 1.3 · minimal". */
export function modelName(model: string | null | undefined, effort?: string | null): string {
  if (!model) return "no model";
  const name = NAMES.find(([pattern]) => pattern.test(model))?.[1] ?? model;
  return effort ? `${name} · ${effort}` : name;
}

export function labelerName(row: TraceLabel): string {
  if (row.labeler === "seed") return "Seeded (demo, no model)";
  if (row.labeler === "deterministic" || (!row.model && row.verifier)) return "Verifier (no model)";
  return modelName(row.model ?? row.labeler);
}

/** Browser-side stages of the latest turn, in order (the hook measures them). */
export const CLIENT_STAGES: [keyof TutorTimeline & string, string][] = [
  ["prepare_ms", "Board saved and cropped"], ["first_move_ms", "First move arrived"], ["first_render_ms", "First move drawn"],
  ["first_audio_ms", "Voice started"], ["drawn_ms", "Turn drawn"], ["total_ms", "Turn finished"],
];

export const seconds = (ms: number | null | undefined) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
