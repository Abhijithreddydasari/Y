import { describe, expect, it } from "vitest";
import { resolveInterfaceMode } from "./interface-mode";

describe("resolveInterfaceMode", () => {
  it("uses device width when there is no override", () => {
    expect(resolveInterfaceMode({ width: 390 })).toBe("mobile");
    expect(resolveInterfaceMode({ width: 744 })).toBe("studio");
  });

  it("prefers the URL and then the remembered choice", () => {
    expect(resolveInterfaceMode({ query: "mobile", stored: "studio", width: 1024 })).toBe("mobile");
    expect(resolveInterfaceMode({ stored: "studio", width: 390 })).toBe("studio");
  });
});
