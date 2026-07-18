"use client";

import { useEffect, useRef, useState } from "react";
import type { ConceptBelief, LatentPoint, LearnerSnapshot } from "@/lib/types";

interface Props {
  snapshot: LearnerSnapshot | null;
  onReset?: () => void;
}

function LatentTrajectory({ points }: { points: LatentPoint[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = 252;
    const height = 145;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let frame = 0;
    let angle = 0.4;
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(99,102,241,.045)";
      ctx.fillRect(0, 0, width, height);
      const projected = points.map((point) => {
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        const xr = point.x * cos - point.z * sin;
        const zr = point.x * sin + point.z * cos;
        return { x: width / 2 + xr * 52, y: height / 2 + point.y * 48 - zr * 9, z: zr };
      });
      if (projected.length) {
        ctx.beginPath();
        projected.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.strokeStyle = "rgba(99,102,241,.55)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        projected.forEach((point, index) => {
          const latest = index === projected.length - 1;
          ctx.beginPath();
          ctx.arc(point.x, point.y, latest ? 5 : 3, 0, Math.PI * 2);
          ctx.fillStyle = latest ? "#10b981" : `rgba(99,102,241,${0.35 + index / Math.max(2, projected.length)})`;
          ctx.fill();
        });
      }
      angle += 0.004;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [points]);
  return <canvas ref={ref} className="rounded-md ring-1 ring-zinc-200 dark:ring-zinc-800" />;
}

function BeliefRow({ belief }: { belief: ConceptBelief }) {
  const low = Math.round(belief.credible_low * 100);
  const high = Math.round(belief.credible_high * 100);
  const mean = Math.round(belief.mastery_mean * 100);
  const trend = belief.trend > 0.05 ? "↗" : belief.trend < -0.05 ? "↘" : "→";
  return (
    <div className="space-y-1 border-t border-zinc-100 py-2 first:border-0 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">{belief.name}</span>
        <span className="shrink-0 text-zinc-500">{mean}% {trend} · n={belief.evidence_count}</span>
      </div>
      <div className="relative h-2 rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="absolute top-0 h-2 rounded-full bg-indigo-200 dark:bg-indigo-900" style={{ left: `${low}%`, width: `${Math.max(2, high - low)}%` }} />
        <div className="absolute -top-0.5 h-3 w-1 rounded bg-emerald-600" style={{ left: `calc(${mean}% - 2px)` }} />
      </div>
      <div className="text-[9px] text-zinc-400">95% belief interval {low}–{high}%</div>
      {belief.misconception && (
        <div className="rounded bg-rose-50 px-1.5 py-1 text-[10px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          Recent misconception: {belief.misconception}
        </div>
      )}
    </div>
  );
}

export default function LearnerPanel({ snapshot, onReset }: Props) {
  const [open, setOpen] = useState(true);
  const state = snapshot?.learner_state;
  const beliefs = state?.concept_beliefs ?? snapshot?.concept_beliefs ?? [];
  const points = state?.latent_trajectory ?? snapshot?.latent_trajectory ?? [];
  return (
    <aside className="pointer-events-auto absolute left-4 top-4 z-30 w-[280px] overflow-hidden rounded-2xl bg-white/95 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-3 py-2.5 text-left">
        <span>
          <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">Learner model</span>
          <span className="block text-[10px] text-zinc-500">Open-vocabulary · probabilistic · Level-2</span>
        </span>
        <span className="text-xs text-zinc-400">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="max-h-[calc(100dvh-100px)] overflow-y-auto border-t border-zinc-100 px-3 pb-3 dark:border-zinc-800">
          <h3 className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Emergent latent trajectory</h3>
          <LatentTrajectory points={points} />
          <div className="mt-1 flex justify-between text-[9px] text-zinc-400">
            <span>{state?.observations ?? 0} evidence events</span>
            <span>{points.length} latent snapshots</span>
          </div>
          <h3 className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Concept beliefs</h3>
          {beliefs.length ? beliefs.slice(0, 8).map((belief) => <BeliefRow key={belief.name} belief={belief} />) : (
            <p className="rounded-md bg-zinc-50 px-2 py-3 text-[11px] italic text-zinc-500 dark:bg-zinc-950">No fixed ability axes. The model will discover concept beliefs as evidence arrives.</p>
          )}
          {state?.profile_text && <p className="mt-2 rounded-md bg-emerald-50 px-2 py-2 text-[10px] leading-relaxed text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{state.profile_text}</p>}
          <div className="mt-3 flex items-center justify-between text-[9px] text-zinc-400">
            <span>{snapshot?.adapter_version ?? "adapter-v1"} · {snapshot?.online_step_count ?? 0} online steps</span>
            <span>{snapshot?.rollback_count ?? 0} rollbacks</span>
          </div>
          {onReset && <button type="button" onClick={onReset} className="mt-2 w-full rounded-md bg-zinc-100 px-2 py-1.5 text-[10px] text-zinc-600 hover:bg-rose-50 hover:text-rose-700 dark:bg-zinc-800">Reset learner data</button>}
        </div>
      )}
    </aside>
  );
}
