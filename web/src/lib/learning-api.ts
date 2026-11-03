import { ensureIdentity } from "./identity";
export interface PracticeTask { task_id: string; prompt: string; concept_ids: string[] }
export interface PracticePack { pack_id: string; title: string; tasks: PracticeTask[] }
export interface CaptureObservation {
  dimension: string;
  label: "supported" | "contradicted" | "not_observable" | "ambiguous";
  status: "accepted" | "abstained" | "pending_review";
  reasons: string[];
  provider: string;
}
export interface CapturedAnswer {
  attempt_id: string;
  session_id: string;
  task_id: string;
  text: string;
  state: "captured" | "assessing" | "assessed";
  retry_allowed: boolean;
  source: { event_id: string; content_hash: string; start: number; end: number };
  assessment: null | {
    observations: CaptureObservation[];
    provider_error: string | null;
    profile_updated: false;
  };
}
export interface CaptureInput {
  attempt_id: string;
  task_id: string;
  text: string;
  assistance: { self_reported_help: boolean; solution_revealed: boolean };
}

export class LearningError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/learning/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { detail?: string };
    throw new LearningError(
    detail.detail === "assessment_retry_limit" ? "This answer reached its retry limit. It remains saved for review."
      : response.status === 409 ? "This attempt is already being checked. Wait a moment and retry."
      : response.status === 429 ? "The assessment limit has been reached. Your answer is saved; retry later."
      : "Could not reach your practice session. Retry to recover your saved work.", response.status);
  }
  return response.json() as Promise<T>;
}

// One identity per page, shared with the board (see identity.ts).
export const ensureLearningIdentity = ensureIdentity;

export const fetchPracticeCatalog = () => request<{ packs: PracticePack[] }>("catalog");
export const createPracticeSession = (id: string) => request<{ session_id: string }>("sessions", { session_id: id });
export const fetchPracticeSession = (id: string) => request<{ attempts: CapturedAnswer[] }>(`sessions/${id}`);
export const captureAnswer = (session: string, input: CaptureInput) => request<CapturedAnswer>(`sessions/${session}/attempts`, input);
export const assessAnswer = (id: string) => request<CapturedAnswer>(`attempts/${id}/assess`, {});
