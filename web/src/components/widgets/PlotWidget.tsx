"use client";

import { useId, useMemo, useState } from "react";
import { compile, sample } from "@/lib/expr";
import type { PlotSpec } from "./widget-spec";

// The size is unchanged from before axes were added, so graphs on saved boards still fit their frame.
const W = 488, H = 230;
const LEFT = 56, RIGHT = 14, TOP = 12, BOTTOM = 44;

function niceRange(ys: Float64Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const y of ys) if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  if (!Number.isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.25;
  return [lo - pad, hi + pad];
}

const scaleX = (x: [number, number]) => (v: number) => LEFT + ((v - x[0]) / (x[1] - x[0])) * (W - LEFT - RIGHT);
const scaleY = (y: [number, number]) => (v: number) => H - BOTTOM - ((v - y[0]) / (y[1] - y[0])) * (H - TOP - BOTTOM);

/** Round tick values (1, 2 or 5 times a power of ten) inside a range, about `count` of them. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  const rough = (hi - lo) / Math.max(1, count);
  if (!(rough > 0) || !Number.isFinite(rough)) return [lo];
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  const step = (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
  const ticks: number[] = [];
  for (let i = Math.ceil(lo / step); i * step <= hi + step * 1e-9; i++) ticks.push(+(i * step).toPrecision(10));
  return ticks;
}

/** Curve paths, broken wherever the function is not finite or leaves the frame far. */
export function plotPath(xs: Float64Array, ys: Float64Array, x: [number, number], y: [number, number]): string {
  const sx = scaleX(x), sy = scaleY(y);
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
  const clip = useId();
  const sx = scaleX(spec.x), sy = scaleY(yRange);
  const xTicks = niceTicks(spec.x[0], spec.x[1]), yTicks = niceTicks(yRange[0], yRange[1]);
  // The axes cross at zero when zero is in view, and otherwise sit on the graph's edge.
  const xAxisAt = sy(yRange[0] <= 0 && yRange[1] >= 0 ? 0 : yRange[0]);
  const yAxisAt = sx(spec.x[0] <= 0 && spec.x[1] >= 0 ? 0 : spec.x[0]);
  const xName = spec.xLabel || "x", yName = spec.yLabel || "y";

  return (
    <div className="flex h-full w-full flex-col gap-2 p-3 text-slate-800">
      <div className="font-mono text-sm">y = {spec.expr}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg bg-slate-50" role="img" aria-label={`Plot of y = ${spec.expr}`}>
        <clipPath id={clip}><rect x={LEFT} y={TOP} width={W - LEFT - RIGHT} height={H - TOP - BOTTOM} /></clipPath>
        {xTicks.map((t) => <line key={`gx${t}`} x1={sx(t)} x2={sx(t)} y1={TOP} y2={H - BOTTOM} stroke="#e2e8f0" />)}
        {yTicks.map((t) => <line key={`gy${t}`} x1={LEFT} x2={W - RIGHT} y1={sy(t)} y2={sy(t)} stroke="#e2e8f0" />)}
        <line data-testid="x-axis" x1={LEFT} x2={W - RIGHT} y1={xAxisAt} y2={xAxisAt} stroke="#475569" strokeWidth={1.25} />
        <line data-testid="y-axis" x1={yAxisAt} x2={yAxisAt} y1={TOP} y2={H - BOTTOM} stroke="#475569" strokeWidth={1.25} />
        <path d={path} clipPath={`url(#${clip})`} fill="none" stroke="#6d28d9" strokeWidth={2.5} strokeLinejoin="round" data-testid="plot-path" />
        {xTicks.map((t) => <text key={`tx${t}`} x={sx(t)} y={H - BOTTOM + 14} fontSize={11} fill="#475569" textAnchor="middle">{t}</text>)}
        {yTicks.map((t) => <text key={`ty${t}`} x={LEFT - 6} y={sy(t) + 4} fontSize={11} fill="#475569" textAnchor="end">{t}</text>)}
        <text data-testid="x-name" x={(LEFT + W - RIGHT) / 2} y={H - 8} fontSize={12} fontWeight={600} fill="#334155" textAnchor="middle">{xName}</text>
        <text data-testid="y-name" transform={`translate(13 ${(TOP + H - BOTTOM) / 2}) rotate(-90)`} fontSize={12} fontWeight={600} fill="#334155" textAnchor="middle">{yName}</text>
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
