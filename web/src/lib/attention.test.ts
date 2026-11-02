import { describe, expect, it } from "vitest";
import { attention, softmax } from "./attention";

const tokens = ["the", "cat", "sat", "on", "the", "mat"];
const entropy = (row: number[]) => -row.reduce((sum, p) => sum + (p > 0 ? p * Math.log(p) : 0), 0);

describe("attention", () => {
  it("rows are probability distributions and deterministic", () => {
    const { weights } = attention(tokens, 1);
    for (const row of weights) {
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(row.every((p) => p >= 0)).toBe(true);
    }
    expect(attention(tokens, 1).weights).toEqual(weights);
  });

  it("lower temperature sharpens and higher temperature flattens every row", () => {
    const cold = attention(tokens, 0.2).weights, warm = attention(tokens, 1).weights, hot = attention(tokens, 5).weights;
    for (let i = 0; i < tokens.length; i++) {
      expect(entropy(cold[i])).toBeLessThan(entropy(warm[i]));
      expect(entropy(warm[i])).toBeLessThan(entropy(hot[i]));
    }
  });

  it("dividing by root d softens unscaled scores", () => {
    const scaled = attention(tokens, 1, true), raw = attention(tokens, 1, false);
    expect(Math.abs(raw.scores[0][1])).toBeCloseTo(Math.abs(scaled.scores[0][1]) * Math.sqrt(8), 8);
    expect(Math.max(...raw.weights[2])).toBeGreaterThan(Math.max(...scaled.weights[2]));
  });

  it("softmax is stable for large scores", () => {
    expect(softmax([1000, 1000])).toEqual([0.5, 0.5]);
  });

  it("a 12-token grid recomputes within a frame", () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const start = performance.now();
    for (let i = 0; i < 50; i++) attention(many, 0.1 + i / 10);
    expect((performance.now() - start) / 50).toBeLessThan(16);
  });
});
