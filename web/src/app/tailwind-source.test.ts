import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tailwind sources", () => {
  it("names the source folder, because foundation files are git-ignored in the event repository", () => {
    // Without this the board's sizing classes are not generated there, and its canvas has height 0.
    const css = readFileSync(resolve(__dirname, "globals.css"), "utf8");
    expect(css).toMatch(/@source\s+"\.\.\/"/);
  });
});
