import { describe, expect, it } from "vitest";
import { compile, ExprError, sample } from "./expr";

const run = (source: string, scope: Record<string, number> = {}) => compile(source, ["x", ...Object.keys(scope)])({ x: 0, ...scope });

describe("compile", () => {
  it("follows precedence, associativity and unary minus", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("2 ^ 3 ^ 2")).toBe(512);
    expect(run("-2^2")).toBe(-4);
    expect(run("2**3")).toBe(8);
    expect(run("10 / 4 - 1")).toBe(1.5);
    expect(run("1.5e1")).toBe(15);
  });

  it("supports variables, constants, functions and implicit products", () => {
    expect(run("a*sin(b*x)", { a: 2, b: 1, x: Math.PI / 2 })).toBeCloseTo(2);
    expect(run("2x + 3(x - 1)", { x: 2 })).toBe(7);
    expect(run("exp(log(5)) + sqrt(16) + abs(-1) + tanh(0) + sigmoid(0)")).toBeCloseTo(10.5);
    expect(run("2pi")).toBeCloseTo(2 * Math.PI);
    expect(run("e")).toBeCloseTo(Math.E);
  });

  it("rejects anything outside the grammar or the declared names", () => {
    for (const bad of ["constructor", "alert(1)", "window", "x.y", "x[0]", "`x`", "x;1", "sin", "1 +", "(x", "x)", "", "a=1",
      "__proto__", "Function('return 1')()", "sin(x", "2 ^"]) {
      expect(() => compile(bad, ["x"]), bad).toThrow(ExprError);
    }
    expect(() => compile("a*x", ["x"])).toThrow(/unknown name "a"/);
    expect(() => compile("x".repeat(201), ["x"])).toThrow(/too long/);
    expect(() => compile("(".repeat(60) + "x" + ")".repeat(60), ["x"])).toThrow(/nested/);
  });

  it("samples evenly and turns non-finite values into gaps", () => {
    const { xs, ys } = sample(compile("1/x", ["x"]), {}, -1, 1, 3);
    expect(Array.from(xs)).toEqual([-1, 0, 1]);
    expect(ys[0]).toBe(-1);
    expect(Number.isNaN(ys[1])).toBe(true);
  });

  it("redraws 200 samples well within a frame", () => {
    const fn = compile("a*sin(b*x) + c*x^2", ["x", "a", "b", "c"]);
    const start = performance.now();
    for (let i = 0; i < 50; i++) sample(fn, { a: 1, b: i / 10, c: 0.1 }, -6, 6);
    expect((performance.now() - start) / 50).toBeLessThan(16);
  });
});
