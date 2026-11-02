// Safe arithmetic for plot widgets: a recursive-descent parser that compiles to a closure tree.
// No eval/Function; only numbers, the declared variables, + - * / ^, parentheses and a fixed
// function list. Unknown names are rejected at compile time, so a spec cannot reach any global.

export class ExprError extends Error {}

export type Scope = Record<string, number>;
export type Compiled = (scope: Scope) => number;

const FUNCTIONS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, ln: Math.log, sqrt: Math.sqrt,
  abs: Math.abs, tanh: Math.tanh, sigmoid: (v) => 1 / (1 + Math.exp(-v)),
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const MAX_LENGTH = 200;
const MAX_DEPTH = 40;

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),]))/y;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) {
      if (!source.slice(index).trim()) break;
      throw new ExprError(`unexpected "${source[index]}"`);
    }
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: "num", value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: "name", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "op", value: match[3] === "**" ? "^" : match[3] });
  }
  return tokens;
}

/** Compile `source` over the given variable names (for example `x` and the slider names). */
export function compile(source: string, variables: readonly string[]): Compiled {
  if (source.length > MAX_LENGTH) throw new ExprError("expression too long");
  const tokens = tokenize(source);
  const known = new Set(variables);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === "op" && peek().value === value;
  const expect = (value: string) => { if (!isOp(value)) throw new ExprError(`expected "${value}"`); pos += 1; };
  const nested = <T>(parse: () => T): T => {
    if (++depth > MAX_DEPTH) throw new ExprError("expression nested too deeply");
    try { return parse(); } finally { depth -= 1; }
  };

  // sum := product (("+" | "-") product)*
  function sum(): Compiled {
    let left = product();
    while (isOp("+") || isOp("-")) {
      const op = tokens[pos++].value, a = left, b = product();
      left = op === "+" ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
    }
    return left;
  }
  // product := unary (("*" | "/" | implicit) unary)*   e.g. 2x, 3(x+1), x sin(x)
  function product(): Compiled {
    let left = unary();
    for (;;) {
      const next = peek();
      const implicit = next && (next.kind === "num" || next.kind === "name" || (next.kind === "op" && next.value === "("));
      if (!isOp("*") && !isOp("/") && !implicit) return left;
      const op = implicit ? "*" : tokens[pos++].value, a = left, b = unary();
      left = op === "*" ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
    }
  }
  // unary := ("-" | "+") unary | power      so -x^2 is -(x^2)
  function unary(): Compiled {
    if (isOp("-")) { pos += 1; const a = nested(unary); return (s) => -a(s); }
    if (isOp("+")) { pos += 1; return nested(unary); }
    return power();
  }
  // power := primary ("^" unary)?           right-associative
  function power(): Compiled {
    const base = primary();
    if (!isOp("^")) return base;
    pos += 1;
    const exponent = nested(unary);
    return (s) => Math.pow(base(s), exponent(s));
  }
  function primary(): Compiled {
    const token = tokens[pos++];
    if (!token) throw new ExprError("unexpected end of expression");
    if (token.kind === "num") { const value = token.value; return () => value; }
    if (token.kind === "op") {
      if (token.value !== "(") throw new ExprError(`unexpected "${token.value}"`);
      const inner = nested(sum);
      expect(")");
      return inner;
    }
    const name = token.value;
    if (Object.hasOwn(FUNCTIONS, name) && isOp("(")) {
      pos += 1;
      const fn = FUNCTIONS[name], arg = nested(sum);
      expect(")");
      return (s) => fn(arg(s));
    }
    if (known.has(name)) return (s) => s[name];
    if (Object.hasOwn(CONSTANTS, name)) { const value = CONSTANTS[name]; return () => value; }
    throw new ExprError(`unknown name "${name}"`);
  }

  if (!tokens.length) throw new ExprError("empty expression");
  const root = sum();
  if (pos < tokens.length) throw new ExprError(`unexpected "${String(tokens[pos].value)}"`);
  return root;
}

/** Evenly spaced samples; non-finite values stay NaN so the caller can break the line there. */
export function sample(fn: Compiled, scope: Scope, from: number, to: number, count = 200): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(count), ys = new Float64Array(count);
  const local = { ...scope };
  for (let i = 0; i < count; i++) {
    const x = from + ((to - from) * i) / (count - 1);
    local.x = x;
    const y = fn(local);
    xs[i] = x;
    ys[i] = Number.isFinite(y) ? y : NaN;
  }
  return { xs, ys };
}
