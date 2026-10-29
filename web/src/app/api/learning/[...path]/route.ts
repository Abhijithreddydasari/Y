// Same-origin boundary for HttpOnly learning identity; upstream URL is server configuration only.
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const ALLOWED = /^(identity|catalog|sessions|sessions\/[a-f0-9-]{36}(?:\/attempts)?|attempts\/[a-f0-9-]{36}(?:\/assess)?)$/;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (!ALLOWED.test(path)) return Response.json({ detail: "Unknown learning endpoint" }, { status: 404 });
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== request.nextUrl.origin)) {
    return Response.json({ detail: "Cross-origin learning request denied" }, { status: 403 });
  }
  const base = (process.env.LEARNING_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  const headers = new Headers({ "Content-Type": "application/json" });
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
      if (length > 40_000) {
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
    const upstream = await fetch(`${base}/learning/${path}`, {
      method: request.method, headers, body: body as BodyInit | undefined,
      cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    const responseHeaders = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
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
