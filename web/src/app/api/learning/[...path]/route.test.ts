// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

afterEach(() => vi.unstubAllGlobals());
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

describe("learning proxy boundary", () => {
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
});
