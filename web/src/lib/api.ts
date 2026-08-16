// Thin client for the FastAPI backend. POSTs a canvas PNG to /lesson and
// streams SSE back. We do not use EventSource because EventSource cannot
// send a POST body; instead we use fetch with a ReadableStream reader.

import type {
  ChatMessage,
  Checkpoint,
  EducatorNotes,
  LearnerState,
  LearnerSnapshot,
  LearnerUpdateEvent,
  LearningEvidence,
  LessonEvent,
  PrimitiveTag,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export interface LessonStreamCallbacks {
  onToken?: (text: string) => void;
  onPrimitive?: (tag: PrimitiveTag) => void;
  onGenerationComplete?: () => void;
  onEducatorNotes?: (notes: EducatorNotes) => void;
  onLearnerUpdate?: (update: LearnerUpdateEvent) => void;
  onLearnerState?: (state: LearnerState) => void;
  onCheckpoint?: (checkpoint: Checkpoint) => void;
  onEvidence?: (evidence: LearningEvidence) => void;
  onDone?: (reason: string) => void;
  onError?: (message: string) => void;
}

export interface LessonStreamOptions {
  teacherMode?: boolean;
  /** Stable per-browser identifier; the backend uses this for the learner. */
  userId?: string;
  /** Toolbar dropdown choice; "edge" | "edge-ft" | "cloud". */
  modelChoice?: string;
  conversationId?: string;
}

export async function streamLesson(
  imageBlob: Blob,
  cb: LessonStreamCallbacks,
  signal?: AbortSignal,
  options: LessonStreamOptions = {},
): Promise<void> {
  const form = new FormData();
  form.append("image", imageBlob, "canvas.png");
  if (options.teacherMode) form.append("teacher_mode", "true");
  if (options.userId) form.append("user_id", options.userId);
  if (options.modelChoice) form.append("model_choice", options.modelChoice);
  if (options.conversationId) form.append("conversation_id", options.conversationId);

  const res = await fetch(`${API_BASE}/lesson`, {
    method: "POST",
    body: form,
    signal,
  });

  if (!res.ok || !res.body) {
    cb.onError?.(`HTTP ${res.status}: ${res.statusText}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // SSE frames are separated by a blank line. sse-starlette on Windows emits
  // CRLF, on Linux just LF. Normalize so a single indexOf("\n\n") works for both.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let nlIdx: number;
    while ((nlIdx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 2);
      handleFrame(frame, cb);
    }
  }
  if (buf.trim()) handleFrame(buf, cb);
}

function handleFrame(frame: string, cb: LessonStreamCallbacks) {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue; // SSE comments / ping heartbeats
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  const raw = dataLines.join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const evt = { event: eventName, data: parsed } as LessonEvent;
  switch (evt.event) {
    case "token":
      cb.onToken?.(evt.data.text);
      break;
    case "primitive":
      cb.onPrimitive?.(evt.data);
      break;
    case "generation_complete":
      cb.onGenerationComplete?.();
      break;
    case "educator_notes":
      cb.onEducatorNotes?.(evt.data);
      break;
    case "learner_update":
      cb.onLearnerUpdate?.(evt.data);
      break;
    case "learner_state":
      cb.onLearnerState?.(evt.data);
      break;
    case "checkpoint":
      cb.onCheckpoint?.(evt.data);
      break;
    case "evidence":
      cb.onEvidence?.(evt.data);
      break;
    case "done":
      cb.onDone?.(evt.data.reason);
      break;
    case "error":
      cb.onError?.(evt.data.message);
      break;
  }
}

export interface HealthInfo {
  status: string;
  ollama_host: string;
  model: string;
  ollama_reachable: boolean;
  schema_exists: boolean;
  models: Record<string, { kind: string; model: string; ready: boolean }>;
  preferred_model: string;
  learner_adapter: Record<string, unknown>;
  speech: { available: boolean; model_version: string; error?: string };
  transcription?: {
    available: boolean;
    model: string;
    loaded: boolean;
    device: string;
    compute_type: string;
    install_hint?: string;
  };
}

export interface ChatStreamOptions {
  messages: ChatMessage[];
  userId: string;
  conversationId: string;
  modelChoice: string;
  lessonContext?: string;
}

export interface ChatStreamCallbacks {
  onDelta?: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export async function streamChat(
  options: ChatStreamOptions,
  cb: ChatStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const messages = options.messages
    .filter((message) => message.content.trim() && !message.pending && !message.error)
    .slice(-24)
    .map(({ role, content }) => ({ role, content: content.slice(0, 8000) }));
  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      user_id: options.userId,
      conversation_id: options.conversationId,
      model_choice: options.modelChoice,
      lesson_context: options.lessonContext ?? "",
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail ?? detail; } catch { /* non-JSON */ }
    cb.onError?.(`HTTP ${response.status}: ${detail}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (frame: string) => {
    let event = "message";
    const lines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) lines.push(line.slice(5).trim());
    }
    if (!lines.length) return;
    try {
      const data = JSON.parse(lines.join("\n")) as { text?: string; message?: string };
      if (event === "delta" && data.text) cb.onDelta?.(data.text);
      else if (event === "done") cb.onDone?.();
      else if (event === "error") cb.onError?.(data.message ?? "Chat failed");
    } catch { /* ignore malformed partial frames */ }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
  }
  if (buffer.trim()) consume(buffer);
}

export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, "recording.wav");
  const response = await fetch(`${API_BASE}/transcribe`, { method: "POST", body: form, signal });
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail ?? detail; } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  const result = await response.json() as { text?: string };
  return result.text?.trim() ?? "";
}

export interface AssessStreamOptions {
  userId: string;
  conversationId: string;
  checkpointId: string;
  modelChoice: string;
}

export async function streamAssessment(
  imageBlob: Blob,
  cb: LessonStreamCallbacks,
  signal: AbortSignal | undefined,
  options: AssessStreamOptions,
): Promise<void> {
  const form = new FormData();
  form.append("image", imageBlob, "answer.png");
  form.append("user_id", options.userId);
  form.append("conversation_id", options.conversationId);
  form.append("checkpoint_id", options.checkpointId);
  form.append("model_choice", options.modelChoice);
  const res = await fetch(`${API_BASE}/assess`, { method: "POST", body: form, signal });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* non-JSON */ }
    cb.onError?.(`HTTP ${res.status}: ${detail}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx), cb);
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleFrame(buf, cb);
}

export async function fetchHealth(): Promise<HealthInfo | null> {
  try {
    const r = await fetch(`${API_BASE}/health`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as HealthInfo;
  } catch {
    return null;
  }
}

export async function fetchLearner(userId: string): Promise<LearnerSnapshot | null> {
  try {
    const r = await fetch(`${API_BASE}/learner/${encodeURIComponent(userId)}`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as LearnerSnapshot;
  } catch {
    return null;
  }
}

export async function resetLearner(userId: string): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/learner/${encodeURIComponent(userId)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}
