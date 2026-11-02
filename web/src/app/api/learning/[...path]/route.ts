// Same-origin boundary for HttpOnly learning identity; upstream URL is server configuration only.
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 180;

const ALLOWED = /^(identity|catalog|sessions|speech|tutor\/options|sessions\/[a-f0-9-]{36}(?:\/attempts)?|attempts\/[a-f0-9-]{36}(?:\/assess)?)$/;
const BOARD = /^(sessions\/[a-f0-9-]{36}\/tutor(?:\/turns)?|sessions\/[a-f0-9-]{36}\/images\/[a-f0-9]{32}|sessions\/[a-f0-9-]{36}\/transcribe(?:\/warm)?|sessions\/[a-f0-9-]{36}\/board(?:\/(?:edits|regions|attempts|context|teach|assets(?:\/[a-f0-9]{64})?))?|board-attempts\/[a-f0-9-]{36}(?:\/(?:assess|corrections))?)$/;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (!ALLOWED.test(path) && !BOARD.test(path)) return Response.json({ detail: "Unknown learning endpoint" }, { status: 404 });
  const streaming = path.endsWith("/teach") || path.endsWith("/tutor/turns");
  const audio = path.endsWith("/transcribe");
  const limit = path.endsWith("/assets") ? 2 * 1024 * 1024 : path.endsWith("/edits") ? 1024 * 1024 : audio ? 1_100_000 : 40_000;
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== request.nextUrl.origin)) {
    return Response.json({ detail: "Cross-origin learning request denied" }, { status: 403 });
  }
  const base = (process.env.LEARNING_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const headers = new Headers({ "Content-Type": path.endsWith("/assets") ? "application/octet-stream" : audio ? "audio/wav" : "application/json" });
  const identity = request.cookies.get("y_learning_identity")?.value;
  if (identity && /^[A-Za-z0-9_-]{43}$/.test(identity)) {
    headers.set("Cookie", `y_learning_identity=${identity}`);
  }
  let body: Uint8Array | undefined;
  if (request.method === "POST" && request.body) {
    const reader = request.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return Response.json({ detail: "Learning request too large" }, { status: 413 });
      }
      parts.push(value);
    }
    body = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  }
  try {
    const revision = request.nextUrl.searchParams.get("revision");
    if (revision !== null && !/^\d{1,9}$/.test(revision)) return Response.json({ detail: "Invalid revision" }, { status: 400 });
    const upstream = await fetch(`${base}/learning/${path}${revision === null ? "" : `?revision=${revision}`}`, {
      method: request.method, headers, body: body as BodyInit | undefined,
      cache: "no-store", redirect: "error",
      // Kokoro's first synthesis loads the voice, so speech gets the longer board timeout.
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(streaming ? 150_000 : BOARD.test(path) || path === "speech" ? 35_000 : 20_000)]),
    });
    const contentType = upstream.headers.get("Content-Type") || "application/json";
    const responseHeaders = new Headers({ "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (streaming) responseHeaders.set("X-Accel-Buffering", "no");
    for (const cookie of upstream.headers.getSetCookie()) {
      if (!cookie.startsWith("y_learning_identity=")) continue;
      const secured = request.nextUrl.protocol === "https:" && !/;\s*Secure(?:;|$)/i.test(cookie)
        ? `${cookie}; Secure` : cookie;
      responseHeaders.append("Set-Cookie", secured);
    }
    const retry = upstream.headers.get("Retry-After");
    if (retry) responseHeaders.set("Retry-After", retry);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ detail: "Learning service unavailable. Your saved attempt can be retried." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };
