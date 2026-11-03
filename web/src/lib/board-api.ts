import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Assistance } from "./board-types";

export type Actor = "human" | "model" | "system" | "unknown";
export interface Rect { x: number; y: number; w: number; h: number }
export interface BoardRecord { element: ExcalidrawElement; revision: number; creator: Actor; editor: Actor; mixed: boolean; task_region: string | null }
export interface Region { region_id: string; task_id: string; bounds: Rect }
export interface BoardState { revision: number; records: Record<string, BoardRecord>; viewport: Rect | null; regions: Region[]; active_region: string | null }
export interface BoardEdit { element: ExcalidrawElement; actor: Actor; source_revision?: number }
export interface Batch { operation_id: string; expected_revision: number; edits: BoardEdit[]; viewport: Rect }
export interface Crop { asset_hash: string; bounds: Rect; element_ids: string[]; purpose: "initial" | "detail" }
export interface ContextRequest { request_id: string; revision: number; region_id: string | null; selection: string[]; viewport: Rect; crops: Crop[]; assistance: Assistance }
export interface Focused { id: string; revision: number; type: string; bounds: Rect; text: string; creator: Actor; mixed: boolean; visual: boolean }
export interface Packet {
  source: { session_id: string; revision: number; element_revisions: Record<string, number>; content_hash: string; crop_hashes: string[] };
  task_id: string | null;
  focused: Focused[];
  response_area: Rect;
  coverage: { complete: boolean; omitted: number; outside_task: string[]; missing_visual: string[] };
  crops?: Crop[];
}
export interface Reading { items: { element_ids: string[]; text: string; status: string; critical: boolean }[]; unresolved: boolean; cache_hit: boolean; calls: number }
export interface BoardAttempt { attempt_id: string; packet: Packet; result: null | { status: string; interpretation: Reading | null; provider_error: string | null; observations: { dimension: string; label: string; status: string }[] }; corrections: { text: string; actor: string }[] }

export class BoardError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export async function boardRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/learning/${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": body instanceof Blob ? body.type : "application/json" },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body), signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new BoardError(response.status, typeof value.detail === "string" ? value.detail : "board_request_failed");
  }
  return response.json() as Promise<T>;
}

let sessionPromise: Promise<string> | null = null;
export function boardSession(): Promise<string> {
  if (!sessionPromise) sessionPromise = (async () => {
    await boardRequest("identity", {});
    let id = localStorage.getItem("y_board_session_v1") || crypto.randomUUID();
    try { await boardRequest("sessions", { session_id: id }); }
    catch (error) {
      if (!(error instanceof BoardError) || error.status !== 404) throw error;
      id = crypto.randomUUID();
      await boardRequest("sessions", { session_id: id });
    }
    localStorage.setItem("y_board_session_v1", id);
    return id;
  })().catch(error => { sessionPromise = null; throw error; });
  return sessionPromise;
}

/** After "End session": the next load starts a fresh board session; the sealed one stays saved on the server. */
export function startNextBoardSession(): void {
  localStorage.setItem("y_board_session_v1", crypto.randomUUID());
  sessionPromise = null;
}

/** Resume a saved session (Canvas): it becomes the board session on the next load. */
export function openBoardSession(id: string): void {
  localStorage.setItem("y_board_session_v1", id);
  sessionPromise = null;
}

/** Read an SSE body frame by frame; a handler may throw to stop reading. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, value: unknown) => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const event = frame.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        if (event && data) onEvent(event, JSON.parse(data));
      }
      if (buffer.length > 131072) throw new Error("Teaching output exceeded its limit.");
    }
  } finally { await reader.cancel(); }
}

export async function streamBoardTeach(session: string, request: ContextRequest, model: string,
  onEvent: (event: string, value: unknown) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/learning/sessions/${session}/board/teach`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, model_choice: model }), signal,
  });
  if (!response.ok || !response.body) throw new Error("Teaching is unavailable; your board is saved.");
  let ended = false;
  await readEvents(response.body, (event, value) => {
    onEvent(event, value);
    if (event === "done") ended = true;
    if (event === "error") throw new Error((value as { message: string }).message);
  });
  if (!ended) throw new Error("The teaching stream stopped. Completed work remains saved.");
}
