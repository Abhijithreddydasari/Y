"use client";

import { useMemo, useState } from "react";
import { compile, sample } from "@/lib/expr";
import type { PlotSpec } from "./widget-spec";

const W = 488, H = 230, PAD = 28;

function niceRange(ys: Float64Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const y of ys) if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  if (!Number.isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.25;
  return [lo - pad, hi + pad];
}

/** Curve paths, broken wherever the function is not finite or leaves the frame far. */
export function plotPath(xs: Float64Array, ys: Float64Array, x: [number, number], y: [number, number]): string {
  const sx = (v: number) => PAD + ((v - x[0]) / (x[1] - x[0])) * (W - 2 * PAD);
  const sy = (v: number) => H - PAD - ((v - y[0]) / (y[1] - y[0])) * (H - 2 * PAD);
  const span = y[1] - y[0];
  let d = "", open = false;
  for (let i = 0; i < xs.length; i++) {
    const v = ys[i];
    if (!Number.isFinite(v) || v < y[0] - 4 * span || v > y[1] + 4 * span) { open = false; continue; }
    d += `${open ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`;
    open = true;
  }
  return d;
}

export default function PlotWidget({ spec }: { spec: PlotSpec }) {
  const names = Object.keys(spec.params);
  const fn = useMemo(() => compile(spec.expr, ["x", ...names]), [spec.expr]); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState(() => Object.fromEntries(names.map((n) => [n, spec.params[n].value])));
  // Fit the y range once to the starting curve and hold it, so a slider visibly moves the curve.
  const yRange = useMemo(() => niceRange(sample(fn, Object.fromEntries(names.map((n) => [n, spec.params[n].value])), spec.x[0], spec.x[1]).ys),
    [fn]); // eslint-disable-line react-hooks/exhaustive-deps
  const { xs, ys } = useMemo(() => sample(fn, values, spec.x[0], spec.x[1]), [fn, values, spec.x]);
  const path = plotPath(xs, ys, spec.x, yRange);
  const zeroY = yRange[0] < 0 && yRange[1] > 0 ? H - PAD - ((0 - yRange[0]) / (yRange[1] - yRange[0])) * (H - 2 * PAD) : null;
  const zeroX = spec.x[0] < 0 && spec.x[1] > 0 ? PAD + ((0 - spec.x[0]) / (spec.x[1] - spec.x[0])) * (W - 2 * PAD) : null;

  return (
    <div className="flex h-full w-full flex-col gap-2 p-3 text-slate-800">
      <div className="font-mono text-sm">y = {spec.expr}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg bg-slate-50" role="img" aria-label={`Plot of y = ${spec.expr}`}>
        {zeroY !== null && <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="#cbd5e1" />}
        {zeroX !== null && <line x1={zeroX} x2={zeroX} y1={PAD} y2={H - PAD} stroke="#cbd5e1" />}
        <path d={path} fill="none" stroke="#6d28d9" strokeWidth={2.5} strokeLinejoin="round" data-testid="plot-path" />
        <text x={PAD} y={H - 8} fontSize={11} fill="#64748b">{spec.x[0]}</text>
        <text x={W - PAD} y={H - 8} fontSize={11} fill="#64748b" textAnchor="end">{spec.x[1]}</text>
        <text x={4} y={PAD} fontSize={11} fill="#64748b">{+yRange[1].toPrecision(3)}</text>
        <text x={4} y={H - PAD} fontSize={11} fill="#64748b">{+yRange[0].toPrecision(3)}</text>
      </svg>
      {names.map((name) => {
        const p = spec.params[name];
        return (
          <label key={name} className="flex items-center gap-3 text-sm">
            <span className="w-16 font-mono">{name} = {+values[name].toPrecision(3)}</span>
            <input type="range" className="flex-1 accent-violet-700" min={p.min} max={p.max} step="any"
              value={values[name]} aria-label={`Parameter ${name}`}
              onChange={(e) => { const v = Number(e.target.value); setValues((old) => ({ ...old, [name]: v })); }} />
          </label>
        );
      })}
    </div>
  );
}
