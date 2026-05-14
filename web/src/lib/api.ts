// Thin client for the FastAPI backend. POSTs a canvas PNG to /lesson and
// streams SSE back. We do not use EventSource because EventSource cannot
// send a POST body; instead we use fetch with a ReadableStream reader.

import type { LessonEvent, PrimitiveTag } from "./types";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export interface LessonStreamCallbacks {
  onToken?: (text: string) => void;
  onPrimitive?: (tag: PrimitiveTag) => void;
  onDone?: (reason: string) => void;
  onError?: (message: string) => void;
}

export async function streamLesson(
  imageBlob: Blob,
  cb: LessonStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("image", imageBlob, "canvas.png");

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
    case "done":
      cb.onDone?.(evt.data.reason);
      break;
    case "error":
      cb.onError?.(evt.data.message);
      break;
  }
}

export async function fetchHealth(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${API_BASE}/health`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
