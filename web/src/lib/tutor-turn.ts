// Client side of a tutor turn: stream moves from the API and map each onto a board primitive.
// Moves have passed server validation; questions arrive without their answer key.
import { BoardError, readEvents, type ContextRequest } from "./board-api";
import type { TutorMove } from "./tutor-moves";
import type { TutorTrace } from "./tutor-options";
import type { PrimitiveTag } from "./types";

/** A predict or check as the browser sees it: no key until the learner has answered. */
export interface TutorQuestion { qid: string; kind: "predict" | "mcq" | "free"; q: string; options: string[] }
export type PublicMove =
  | Exclude<TutorMove, { type: "predict" | "check" | "image" }>
  /** The server adds the id of the illustration job it started for this move. */
  | { type: "image"; prompt: string; alt: string; image_id?: string }
  | { type: "predict" | "check"; kind: "mcq" | "free"; q: string; options: string[]; qid: string | null };

export interface TurnBody {
  turn_id: string;
  kind: "question" | "answer";
  text?: string;
  question_id?: string;
  choice?: string;
  confidence?: number | null;
  reveal?: boolean;
  /** How the learner answered, recorded as evidence; the server defaults to tap for a choice and typed for text. */
  via?: "tap" | "typed" | "spoken" | "ink";
  /** Tutor option id from GET /learning/tutor/options; the server resolves it against its allowlist. */
  model?: string;
  board?: ContextRequest;
}

export interface TutorTimeline { [stage: string]: number }
/** What the learner model contributed to a turn: the brief items the tutor read (none with Memory off). */
export interface TurnMemory { on: boolean; revision: number | null; items: { id: string; kind: string; text: string }[] }
/** Result of sealing a session at "End session". */
export interface CloseSummary {
  revision: number | null; sealed: number; profile_updated: boolean; replayed: boolean;
  misconceptions?: string[]; notes?: string[]; beliefs?: { concept: string; dimension: string; mean: number }[];
}
export interface TutorTurnEvents {
  onTurn?: (value: { turn_id: string; outcome: { qid: string; result: string } | null }) => void;
  onMove: (move: PublicMove, index: number) => void;
  onDone: (value: { status: string; question: TutorQuestion | null; timing?: TutorTimeline; tutor?: TutorTrace;
    memory?: TurnMemory }) => void;
}
export interface TutorState {
  configured: boolean;
  model: string;
  open: TutorQuestion | null;
  turns: { turn_id: string; seq: number; kind: string; status: string; learner: string; goals: string[]; said: string[];
    tutor?: TutorTrace | null }[];
}

const MESSAGES: Record<string, string> = {
  tutor_not_configured: "The tutor is not configured on the server (MODEL_API_KEY is missing). Your question and board are kept.",
  tutor_question_not_open: "That question is no longer open. Ask a new question instead.",
  tutor_model_unknown: "That tutor model is not offered here. Pick another in the menu beside Ask.",
  tutor_model_unavailable: "That tutor model is not configured on this server. Pick another in the menu beside Ask.",
  tutor_turn_in_progress: "The tutor is still answering. Wait for it to finish or press Stop.",
  session_closed: "This session has ended. Start a new one to keep learning.",
  session_closing: "This session is being saved. Wait a moment.",
  assessment_budget_exhausted: "The hourly tutor limit is reached. Your question and board are kept; try again later.",
  learning_identity_required: "Your learning session expired. Reload the page to continue.",
};
export function tutorErrorMessage(error: unknown): string {
  if (error instanceof BoardError) return MESSAGES[error.code] ?? "The tutor is unavailable right now. Your question and board are kept.";
  return (error as Error)?.message || "The tutor is unavailable right now. Your question and board are kept.";
}

export const cardId = (qid: string) => `y-card-${qid}`;

/** Board primitive for a move, or null for moves that do not draw (say, turn_end) or are not rendered yet. */
export function moveToPrimitive(move: PublicMove): PrimitiveTag | null {
  switch (move.type) {
    case "seg": return { tag: "title", args: { text: move.goal } };
    case "write": return { tag: "text", args: { content: move.text } };
    case "equation": return { tag: "equation", args: { latex: move.latex } };
    case "diagram": return { tag: "diagram", args: { mermaid: move.mermaid } };
    case "widget": return { tag: "widget", args: { kind: move.kind, spec: move.spec } };
    case "because": return { tag: "chip", args: { text: move.text } };
    case "image": return move.image_id ? { tag: "image", args: { id: move.image_id, alt: move.alt } } : null;
    case "predict":
    case "check":
      if (!move.qid) return null;
      return { tag: "card", args: { id: cardId(move.qid), label: move.type === "predict" ? "Predict" : "Check", q: move.q,
        options: move.options.join("\n") } };
    default: return null;
  }
}

export function questionOf(move: PublicMove): TutorQuestion | null {
  if ((move.type !== "predict" && move.type !== "check") || !move.qid) return null;
  return { qid: move.qid, kind: move.type === "predict" ? "predict" : move.kind, q: move.q, options: move.options };
}

async function failure(response: Response): Promise<BoardError> {
  const value = await response.json().catch(() => ({}));
  return new BoardError(response.status, typeof value.detail === "string" ? value.detail : "tutor_request_failed");
}

export async function fetchTutorState(session: string): Promise<TutorState> {
  const response = await fetch(`/api/learning/sessions/${session}/tutor`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<TutorState>;
}

export async function closeSession(session: string): Promise<CloseSummary> {
  const response = await fetch(`/api/learning/sessions/${session}/close`, { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<CloseSummary>;
}

export async function setSessionMemory(session: string, memory: boolean): Promise<boolean> {
  const response = await fetch(`/api/learning/sessions/${session}/memory`, {
    method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memory }),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { memory: boolean }).memory;
}

export async function fetchSessionMemory(session: string): Promise<boolean> {
  const response = await fetch(`/api/learning/sessions/${session}/memory`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { memory: boolean }).memory;
}

export async function streamTutorTurn(session: string, body: TurnBody, handlers: TutorTurnEvents, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/learning/sessions/${session}/tutor/turns`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!response.ok || !response.body) throw await failure(response);
  let ended = false;
  await readEvents(response.body, (event, value) => {
    if (event === "turn") handlers.onTurn?.(value as Parameters<NonNullable<TutorTurnEvents["onTurn"]>>[0]);
    else if (event === "move") { const { move, index } = value as { move: PublicMove; index: number }; handlers.onMove(move, index); }
    else if (event === "error") throw new Error((value as { message: string }).message);
    else if (event === "done") { ended = true; handlers.onDone(value as Parameters<TutorTurnEvents["onDone"]>[0]); }
  });
  if (!ended) throw new Error("The tutor stopped early. What was drawn is kept; ask again to continue.");
}
