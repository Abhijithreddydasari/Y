import { describe, expect, it } from "vitest";
import { legacyApiConfigured } from "./legacy-api";

describe("legacy service gate", () => {
  it("calls the legacy service only when its address is set", () => {
    expect(legacyApiConfigured({})).toBe(false);
    expect(legacyApiConfigured({ NEXT_PUBLIC_API_BASE: "" })).toBe(false);
    expect(legacyApiConfigured({ NEXT_PUBLIC_API_BASE: "https://legacy.example" })).toBe(true);
  });
});
