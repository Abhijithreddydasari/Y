// Client side of a tutor turn: stream moves from the API and map each onto a board primitive.
// Moves have passed server validation; questions arrive without their answer key.
import { BoardError, readEvents, type ContextRequest, type Rect } from "./board-api";
import type { TutorMove } from "./tutor-moves";
import type { TutorTrace } from "./tutor-options";
import type { PrimitiveTag } from "./types";

/** A predict or check as the browser sees it: no key until the learner has answered. */
/** `origin` marks a warm-up review or the exit ticket; `hints` are the ladder rungs already given (restore only). */
export interface TutorQuestion { qid: string; kind: "predict" | "mcq" | "free"; q: string; options: string[];
  origin?: "review" | "exit"; hints?: Hint[] }
export interface Hint { level: number; text: string }
/** A warm-up item due now: a concept from an earlier session and the check that will be re-asked. */
export interface ReviewItem { concept: string; reason: "misconception" | "fading" | "shaky"; q: string; retention: number; mean: number }
/** A saved session (Canvas) to resume. */
export interface Canvas { session_id: string; title: string; sealed: boolean; created_at: number; turns: number }
export type PublicMove =
  | Exclude<TutorMove, { type: "predict" | "check" | "image" | "point" }>
  /** The server maps the crop point to the board and snaps it to the learner's ink line (`at`). */
  | (Extract<TutorMove, { type: "point" }> & { at?: Rect; raw?: { x: number; y: number }; snap?: "line" | "nearest" | "raw"; lines?: number })
  /** The server adds the id of the illustration job it started for this move. */
  | { type: "image"; prompt: string; alt: string; image_id?: string }
  | { type: "predict" | "check"; kind: "mcq" | "free"; q: string; options: string[]; qid: string | null };

export interface TurnBody {
  turn_id: string;
  /** review: a warm-up re-asking an earlier check (drawn without a model call); exit: the exit ticket. */
  kind: "question" | "answer" | "review" | "exit";
  /** review only: the due concept. */
  concept?: string;
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
  /** The demo persona whose mind kept this session; null for your own. */
  persona?: string | null;
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
  hint_leaked: "No hint right now. Try again, or tap Just tell me.",
  hint_invalid: "No hint right now. Try again, or tap Just tell me.",
  hint_out_of_order: "That hint is not available yet.",
  review_not_found: "That review is no longer available.",
  assessment_budget_exhausted: "The hourly tutor limit is reached. Your question and board are kept; try again later.",
  learning_identity_required: "Your learning session expired. Reload the page to continue.",
};
export function tutorErrorMessage(error: unknown): string {
  if (error instanceof BoardError) return MESSAGES[error.code] ?? "The tutor is unavailable right now. Your question and board are kept.";
  return (error as Error)?.message || "The tutor is unavailable right now. Your question and board are kept.";
}

export const cardId = (qid: string) => `y-card-${qid}`;
/** Sent when the learner presses Ask with an empty box and their question is on the board. */
export const BOARD_QUESTION = "Answer the question I wrote on the board. If it shows my working, check it step by step.";
export const pointId = (turnId: string, index: number) => `y-point-${turnId}-${index}`;

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
      // The board keeps the question as a record and an anchor; its options live on the answer card beside it.
      return { tag: "card", args: { id: cardId(move.qid), label: move.type === "predict" ? "Predict" : "Check", q: move.q, options: "" } };
    default: return null;
  }
}

export function questionOf(move: PublicMove): TutorQuestion | null {
  if ((move.type !== "predict" && move.type !== "check") || !move.qid) return null;
  return { qid: move.qid, kind: move.type === "predict" ? "predict" : move.kind, q: move.q, options: move.options };
}

/** Leading option letter as typed: "B", "b)", "A, because…", "(c) the scores". A bare "a word" is an article. */
const TYPED_LETTER = /^\(?([a-z])(?:$|[).,:;-]|\s*\)|\s+(?:because|since|as)\b)/i;

/**
 * Text typed into the composer while a card waits: an answer to that card, or null for a new question.
 * A question mark always means a question; option cards need a leading letter or exactly one option's
 * text, so a typed request that merely shares words with an option is never graded as an answer.
 */
export function composerAnswer(question: TutorQuestion, typed: string): { choice?: string; text: string } | null {
  const text = typed.trim();
  if (!text || text.endsWith("?")) return null;
  if (question.kind === "free") return { text };
  const letter = text.match(TYPED_LETTER)?.[1]?.toLowerCase();
  if (letter) {
    const index = letter.charCodeAt(0) - 97;
    return index < question.options.length ? { choice: question.options[index], text } : null;
  }
  const flat = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  const said = flat(text);
  const named = question.options.filter((option) => flat(option) && said.includes(flat(option)));
  return named.length === 1 ? { choice: named[0], text } : null;
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

/** Seal the session; `into` ("own" or a persona key) first moves it to another of this browser's minds. */
export async function closeSession(session: string, into?: string): Promise<CloseSummary> {
  const response = await fetch(`/api/learning/sessions/${session}/close`, { method: "POST", credentials: "same-origin",
    ...(into ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ into }) } : {}) });
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
  return (await fetchSessionStatus(session)).memory;
}

/** Memory switch and whether the session is still open (a sealed canvas can be viewed, not asked in). */
export async function fetchSessionStatus(session: string): Promise<{ memory: boolean; status: string }> {
  const response = await fetch(`/api/learning/sessions/${session}/memory`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<{ memory: boolean; status: string }>;
}

export async function fetchReview(session: string): Promise<ReviewItem[]> {
  const response = await fetch(`/api/learning/sessions/${session}/review`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { items: ReviewItem[] }).items;
}

export async function requestHint(session: string, qid: string, level: number): Promise<Hint[]> {
  const response = await fetch(`/api/learning/sessions/${session}/tutor/hints`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qid, level }),
  });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { hints: Hint[] }).hints;
}

export async function fetchCanvases(): Promise<Canvas[]> {
  const response = await fetch("/api/learning/canvases", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { canvases: Canvas[] }).canvases;
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
