import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PORTRAITS } from "./discovery-portraits";

describe("discovery portraits", () => {
  it("has a file and a credit for every portrait", () => {
    for (const person of PORTRAITS) {
      expect(existsSync(resolve(process.cwd(), "public/discovery/frames", person.frame)), person.frame).toBe(true);
      expect(person.source).toMatch(/^https:\/\//);
      expect(person.license).not.toBe("");
      expect(person.credit).not.toBe("");
    }
  });

  it("links the license wherever one must be credited", () => {
    const licensed = PORTRAITS.filter((person) => person.license !== "Public domain");
    expect(licensed.length).toBeGreaterThan(0);
    for (const person of licensed) expect(person.licenseUrl, person.name).toMatch(/^https?:\/\//);
  });

  it("leaves out the people we chose not to show", () => {
    const names = PORTRAITS.map((person) => person.name);
    for (const name of ["Wernher von Braun", "Fritz Haber", "Tim Berners-Lee", "Donald Knuth", "Barbara Liskov"]) expect(names).not.toContain(name);
    expect(new Set(names).size).toBe(names.length);
  });
});
