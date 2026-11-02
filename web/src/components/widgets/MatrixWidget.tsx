"use client";

import { useMemo, useState } from "react";
import type { MatrixSpec } from "./widget-spec";

/** Determinant by Gaussian elimination with partial pivoting; null for non-square matrices. */
export function determinant(m: readonly (readonly number[])[]): number | null {
  const n = m.length;
  if (!n || m.some((row) => row.length !== n)) return null;
  const a = m.map((row) => [...row]);
  let det = 1;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-12) return 0;
    if (pivot !== c) { [a[pivot], a[c]] = [a[c], a[pivot]]; det = -det; }
    det *= a[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return Math.abs(det) < 1e-12 ? 0 : det;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const SIZE = 220, UNIT = 34;

/** The unit square and its image under a 2×2 matrix, with the basis vectors. */
function UnitSquare({ m }: { m: number[][] }) {
  const [[a, b], [c, d]] = m;
  const p = (x: number, y: number) => `${SIZE / 2 + x * UNIT},${SIZE / 2 - y * UNIT}`;
  const image = [p(0, 0), p(a, c), p(a + b, c + d), p(b, d)].join(" ");
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full rounded-lg bg-slate-50" role="img" aria-label="Unit square and its image">
      <line x1={0} x2={SIZE} y1={SIZE / 2} y2={SIZE / 2} stroke="#e2e8f0" />
      <line y1={0} y2={SIZE} x1={SIZE / 2} x2={SIZE / 2} stroke="#e2e8f0" />
      <polygon points={[p(0, 0), p(1, 0), p(1, 1), p(0, 1)].join(" ")} fill="#e2e8f0" stroke="#94a3b8" strokeDasharray="3 3" />
      <polygon points={image} fill="rgba(109,40,217,.18)" stroke="#6d28d9" strokeWidth={1.5} data-testid="image-square" />
      <line x1={SIZE / 2} y1={SIZE / 2} x2={SIZE / 2 + a * UNIT} y2={SIZE / 2 - c * UNIT} stroke="#dc2626" strokeWidth={2.5} />
      <line x1={SIZE / 2} y1={SIZE / 2} x2={SIZE / 2 + b * UNIT} y2={SIZE / 2 - d * UNIT} stroke="#2563eb" strokeWidth={2.5} />
    </svg>
  );
}

export default function MatrixWidget({ spec }: { spec: MatrixSpec }) {
  const [m, setM] = useState(() => spec.m.map((row) => [...row]));
  const det = useMemo(() => determinant(m), [m]);
  const square = m.length === 2 && m[0].length === 2;
  const set = (i: number, j: number, value: string) => {
    const v = Number(value);
    if (Number.isFinite(v)) setM((old) => old.map((row, r) => (r === i ? row.map((x, c) => (c === j ? v : x)) : row)));
  };

  return (
    <div className="flex h-full w-full gap-3 p-3 text-slate-800">
      <div className="flex flex-col justify-center gap-2">
        <div className="grid gap-1 border-x-2 border-slate-700 px-1.5" style={{ gridTemplateColumns: `repeat(${m[0].length}, 3.4rem)` }}>
          {m.map((row, i) => row.map((v, j) => (
            <input key={`${i}-${j}`} type="number" step={0.5} defaultValue={v} aria-label={`Entry row ${i + 1} column ${j + 1}`}
              onChange={(e) => e.target.value.trim() && set(i, j, e.target.value)}
              className={`h-9 rounded-md border border-slate-200 text-center font-mono text-sm ${square && j === 0 ? "text-red-600" : square ? "text-blue-600" : ""}`} />
          )))}
        </div>
        {det !== null && <div className="text-sm">det = <b data-testid="det">{fmt(det)}</b></div>}
        {square && det !== null && <div className="max-w-[12rem] text-xs text-slate-500">
          {det === 0 ? "The square collapses: the columns are parallel." : `Areas scale by ${fmt(Math.abs(det))}${det < 0 ? ", and orientation flips" : ""}.`}
        </div>}
      </div>
      {square && <div className="min-w-0 flex-1"><UnitSquare m={m} /></div>}
    </div>
  );
}
