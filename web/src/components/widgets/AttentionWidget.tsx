"use client";

import { useMemo, useState } from "react";
import { attention } from "@/lib/attention";
import type { AttentionSpec } from "./widget-spec";

export default function AttentionWidget({ spec }: { spec: AttentionSpec }) {
  const [temp, setTemp] = useState(() => Math.min(5, Math.max(0.1, spec.temp)));
  const [scaled, setScaled] = useState(true);
  const [query, setQuery] = useState(spec.tokens.length - 1);
  const { weights } = useMemo(() => attention(spec.tokens, temp, scaled), [spec.tokens, temp, scaled]);
  const n = spec.tokens.length;
  const row = weights[query];

  return (
    <div className="flex h-full w-full flex-col gap-2 p-3 text-slate-800">
      <div className="text-sm">Which words does <b>{spec.tokens[query]}</b> attend to? <span className="text-slate-500">(tap a row)</span></div>
      <div className="grid gap-[2px] text-xs" style={{ gridTemplateColumns: `72px repeat(${n}, minmax(0, 1fr))` }} role="grid">
        <div />
        {spec.tokens.map((t, j) => <div key={`k${j}`} className="truncate text-center font-mono text-slate-500">{t}</div>)}
        {weights.map((r, i) => (
          <div key={`r${i}`} className="contents" role="row">
            <button type="button" className={`truncate text-right font-mono ${i === query ? "font-bold text-violet-700" : ""}`}
              onClick={() => setQuery(i)}>{spec.tokens[i]}</button>
            {r.map((w, j) => (
              <div key={j} className={`flex h-6 cursor-pointer items-center justify-center rounded-sm ${i === query ? "ring-1 ring-violet-500" : ""}`}
                style={{ backgroundColor: `rgba(109, 40, 217, ${0.06 + 0.94 * w})`, color: w > 0.5 ? "white" : "#334155" }}
                data-testid={`cell-${i}-${j}`} data-control onClick={() => setQuery(i)}>{Math.round(w * 100)}</div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-end gap-1" aria-label={`Weights for ${spec.tokens[query]}`}>
        {row.map((w, j) => (
          <div key={j} className="flex flex-1 flex-col items-center">
            <div className="w-full rounded-t bg-violet-600 transition-[height] duration-75" style={{ height: `${Math.max(2, w * 44)}px` }} />
          </div>
        ))}
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span className="w-28">temperature {temp.toFixed(2)}</span>
        <input type="range" min={0.1} max={5} step={0.05} value={temp} className="flex-1 accent-violet-700" aria-label="Temperature"
          onChange={(e) => setTemp(Number(e.target.value))} />
      </label>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input type="checkbox" checked={scaled} onChange={(e) => setScaled(e.target.checked)} /> divide by √d
        </label>
        <span>softmax(q·k / ({scaled ? "√d·T" : "T"})) · toy embeddings, d = 8</span>
      </div>
    </div>
  );
}
