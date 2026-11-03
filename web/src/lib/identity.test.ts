import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureIdentity, resetIdentity } from "./identity";

afterEach(() => { vi.unstubAllGlobals(); resetIdentity(); });

describe("page identity", () => {
  it("makes one identity call however many first requests race, and retries after a failure", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValue(new Response('{"ready":true,"persona":"priya"}'));
    vi.stubGlobal("fetch", fetcher);
    await expect(ensureIdentity()).rejects.toThrow("identity 503");
    const [a, b, c] = await Promise.all([ensureIdentity(), ensureIdentity(), ensureIdentity()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
    expect(c.persona).toBe("priya");
    await ensureIdentity();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
