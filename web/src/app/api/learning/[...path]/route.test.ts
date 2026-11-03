// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST, PUT } from "./route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

describe("learning proxy boundary", () => {
  it("preserves board revision queries, binary assets and teaching streams", async () => {
    const sid = "12345678-1234-1234-1234-123456789abc";
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }))
      .mockResolvedValueOnce(new Response("event: done\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetcher);
    await GET(new NextRequest(`https://y.test/api/learning/sessions/${sid}/board?revision=5`), context(`sessions/${sid}/board`));
    expect(fetcher.mock.calls[0][0]).toContain("?revision=5");
    const image = await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/board/assets/${"a".repeat(64)}`));
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2]);
    const stream = await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST", body: "{}" }), context(`sessions/${sid}/board/teach`));
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await stream.text()).toContain("event: done");
  });
  it("forwards tutor state and streams tutor turns", async () => {
    const sid = "12345678-1234-1234-1234-123456789abc";
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"configured":true}'))
      .mockResolvedValueOnce(new Response("event: done\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/tutor`))).status).toBe(200);
    const turn = await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST", body: "{}" }), context(`sessions/${sid}/tutor/turns`));
    expect(turn.headers.get("X-Accel-Buffering")).toBe("no");
    expect(fetcher.mock.calls[1][0]).toContain(`/learning/sessions/${sid}/tutor/turns`);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/tutor/other`))).status).toBe(404);
  });
  it("forwards the tutor options list and nothing beside it", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"models":[],"voices":[]}'));
    vi.stubGlobal("fetch", fetcher);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context("tutor/options"))).status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toContain("/learning/tutor/options");
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context("tutor/models"))).status).toBe(404);
    const sid = "12345678-1234-1234-1234-123456789abc";
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/images/${"c".repeat(32)}`))).status).toBe(200);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/images/../x`))).status).toBe(404);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/evidence`))).status).toBe(200);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/evidence/x`))).status).toBe(404);
  });
  it("forwards push-to-talk audio as WAV and serves Kokoro speech", async () => {
    const sid = "12345678-1234-1234-1234-123456789abc";
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"text":"hi"}'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "Content-Type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetcher);
    const wav = new Uint8Array(500_000);
    const sent = await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST", body: wav }), context(`sessions/${sid}/transcribe`));
    expect(sent.status).toBe(200);
    expect((fetcher.mock.calls[0][1].headers as Headers).get("Content-Type")).toBe("audio/wav");
    expect((fetcher.mock.calls[0][1].body as Uint8Array).byteLength).toBe(500_000);
    await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST" }), context(`sessions/${sid}/transcribe/warm`));
    expect(fetcher.mock.calls[1][0]).toContain(`/learning/sessions/${sid}/transcribe/warm`);
    const speech = await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST", body: '{"text":"hi"}' }), context("speech"));
    expect(speech.headers.get("Content-Type")).toBe("audio/wav");
    const huge = await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST", body: new Uint8Array(1_100_001) }), context(`sessions/${sid}/transcribe`));
    expect(huge.status).toBe(413);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects cross-origin writes and arbitrary paths before forwarding", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const cross = await POST(new NextRequest("https://y.test/api/learning/identity", {
      method: "POST", headers: { Origin: "https://attacker.test" },
    }), context("identity"));
    expect(cross.status).toBe(403);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context("../health"))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards only the learning credential and preserves HttpOnly cookies", async () => {
    const cookie = "y_learning_identity=" + "a".repeat(43);
    const fetcher = vi.fn().mockResolvedValue(new Response('{"ready":true}', {
      headers: { "Set-Cookie": `${cookie}; HttpOnly; Path=/; SameSite=Strict` },
    }));
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(new NextRequest("https://y.test/api/learning/identity", {
      method: "POST", headers: { Cookie: `${cookie}; unrelated=secret`, Origin: "https://y.test" }, body: "{}",
    }), context("identity"));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const headers = fetcher.mock.calls[0][1].headers as Headers;
    expect(headers.get("Cookie")).toBe(cookie);
  });

  it("limits body size and gives a recoverable upstream failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("internal host secret"));
    vi.stubGlobal("fetch", fetcher);
    const oversized = await POST(new NextRequest("https://y.test/api/learning/sessions", {
      method: "POST", body: "x".repeat(40_001),
    }), context("sessions"));
    expect(oversized.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
    const failed = await GET(new NextRequest("https://y.test/api/learning/catalog"), context("catalog"));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("internal host secret");
  });
  it("forwards session close, the memory switch and the profile with a bounded topic", async () => {
    const sid = "12345678-1234-1234-1234-123456789abc";
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetcher);
    expect((await POST(new NextRequest("https://y.test/api/learning/x", { method: "POST" }), context(`sessions/${sid}/close`))).status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toContain(`/learning/sessions/${sid}/close`);
    const put = await PUT(new NextRequest("https://y.test/api/learning/x", { method: "PUT", body: '{"memory":false}' }), context(`sessions/${sid}/memory`));
    expect(put.status).toBe(200);
    expect(fetcher.mock.calls[1][1].method).toBe("PUT");
    expect(new TextDecoder().decode(fetcher.mock.calls[1][1].body as Uint8Array)).toBe('{"memory":false}');
    await GET(new NextRequest(`https://y.test/api/learning/profile?q=${"a".repeat(300)}&x=1`), context("profile"));
    expect(fetcher.mock.calls[2][0]).toMatch(/\/learning\/profile\?q=a{200}$/);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/close/x`))).status).toBe(404);
    expect((await GET(new NextRequest("https://y.test/api/learning/x"), context(`sessions/${sid}/trace`))).status).toBe(200);
    expect(fetcher.mock.calls[3][0]).toContain(`/learning/sessions/${sid}/trace`);
  });
  it("sends the proxy secret upstream only, never back to the browser", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"ready":true}', {
      headers: { "Set-Cookie": "y_learning_identity=" + "b".repeat(43) + "; HttpOnly; Path=/; SameSite=Strict" },
    }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("LEARNING_API_BASE", "https://api.example.modal.run/");
    vi.stubEnv("LEARNING_PROXY_SECRET", "proxy-secret-value");
    const response = await POST(new NextRequest("https://y.test/api/learning/identity", { method: "POST", body: "{}" }), context("identity"));
    expect(fetcher.mock.calls[0][0]).toBe("https://api.example.modal.run/learning/identity");
    expect((fetcher.mock.calls[0][1].headers as Headers).get("X-Y-Proxy-Secret")).toBe("proxy-secret-value");
    expect([...response.headers.values()].join(" ")).not.toContain("proxy-secret-value");
    // On https the relayed identity cookie is Secure even if upstream forgot.
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly.*; Secure$/);
    vi.stubEnv("LEARNING_PROXY_SECRET", "");
    await POST(new NextRequest("https://y.test/api/learning/identity", { method: "POST", body: "{}" }), context("identity"));
    expect((fetcher.mock.calls[1][1].headers as Headers).has("X-Y-Proxy-Secret")).toBe(false);
  });
});
