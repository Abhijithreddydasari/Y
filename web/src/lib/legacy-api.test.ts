import { describe, expect, it } from "vitest";
import { legacyApiConfigured } from "./legacy-api";

describe("legacy service gate", () => {
  it("calls the legacy service locally, and in production only when a deployment names it", () => {
    expect(legacyApiConfigured({ NODE_ENV: "development" })).toBe(true);
    expect(legacyApiConfigured({ NODE_ENV: "production" })).toBe(false);
    expect(legacyApiConfigured({ NODE_ENV: "production", NEXT_PUBLIC_API_BASE: "https://legacy.example" })).toBe(true);
  });
});
