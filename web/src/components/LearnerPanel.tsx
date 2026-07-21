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
    const width = 288;
    const height = 164;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let frame = 0;
    let angle = 0.4;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const background = ctx.createRadialGradient(
        width / 2, height / 2, 2, width / 2, height / 2, width * 0.58,
      );
      background.addColorStop(0, "rgba(79,70,229,.14)");
      background.addColorStop(0.55, "rgba(16,185,129,.045)");
      background.addColorStop(1, "rgba(15,23,42,.02)");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(99,102,241,.11)";
      ctx.lineWidth = 1;
      for (let ring = 1; ring <= 3; ring += 1) {
        ctx.beginPath();
        ctx.ellipse(width / 2, height / 2, ring * 38, ring * 18, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(18, height / 2);
      ctx.lineTo(width - 18, height / 2);
      ctx.moveTo(width / 2, 14);
      ctx.lineTo(width / 2, height - 14);
      ctx.stroke();

      if (!points.length) {
        ctx.fillStyle = "rgba(100,116,139,.75)";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Learning space forms as evidence arrives", width / 2, height / 2 + 4);
      } else {
        const maxMagnitude = Math.max(
          1,
          ...points.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))),
        );
        const scale = 56 / maxMagnitude;
        const projected = points.map((point) => {
          const sin = Math.sin(angle);
          const cos = Math.cos(angle);
          const xr = point.x * cos - point.z * sin;
          const zr = point.x * sin + point.z * cos;
          return {
            x: width / 2 + xr * scale,
            y: height / 2 + point.y * scale * 0.72 - zr * scale * 0.16,
          };
        });

        if (projected.length > 1) {
          const trail = ctx.createLinearGradient(0, 0, width, height);
          trail.addColorStop(0, "rgba(99,102,241,.22)");
          trail.addColorStop(1, "rgba(16,185,129,.8)");
          ctx.beginPath();
          projected.forEach((point, index) => {
            if (index) ctx.lineTo(point.x, point.y);
            else ctx.moveTo(point.x, point.y);
          });
          ctx.strokeStyle = trail;
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }

        projected.forEach((point, index) => {
          const latest = index === projected.length - 1;
          if (latest) {
            const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 15);
            glow.addColorStop(0, "rgba(52,211,153,.45)");
            glow.addColorStop(1, "rgba(52,211,153,0)");
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.arc(point.x, point.y, latest ? 5 : 2.7, 0, Math.PI * 2);
          ctx.fillStyle = latest
            ? "#10b981"
            : `rgba(99,102,241,${0.25 + index / Math.max(2, projected.length)})`;
          ctx.fill();
        });
      }

      angle += 0.004;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [points]);

  return (
    <canvas
      ref={ref}
      aria-label="Rotating three-dimensional learner-state trajectory"
      className="max-w-full rounded-xl ring-1 ring-indigo-100 dark:ring-indigo-950"
    />
  );
}

function BeliefRow({ belief }: { belief: ConceptBelief }) {
  const low = Math.round(belief.credible_low * 100);
  const high = Math.round(belief.credible_high * 100);
  const mean = Math.round(belief.mastery_mean * 100);
  const trend = belief.trend > 0.05 ? "↑" : belief.trend < -0.05 ? "↓" : "→";
  return (
    <div className="space-y-1 border-t border-zinc-100 py-2 first:border-0 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">{belief.name}</span>
        <span className="shrink-0 text-zinc-500">{mean}% {trend} · n={belief.evidence_count}</span>
      </div>
      <div className="relative h-2 rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="absolute top-0 h-2 rounded-full bg-indigo-200 dark:bg-indigo-900"
          style={{ left: `${low}%`, width: `${Math.max(2, high - low)}%` }}
        />
        <div
          className="absolute -top-0.5 h-3 w-1 rounded bg-emerald-600"
          style={{ left: `calc(${mean}% - 2px)` }}
        />
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

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export default function LearnerPanel({ snapshot, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const state = snapshot?.learner_state;
  const beliefs = state?.concept_beliefs ?? snapshot?.concept_beliefs ?? [];
  const points = state?.latent_trajectory ?? snapshot?.latent_trajectory ?? [];
  const observations = state?.observations ?? 0;
  const latest = points.at(-1);
  const meanMastery = beliefs.length
    ? beliefs.reduce((sum, belief) => sum + belief.mastery_mean, 0) / beliefs.length
    : 0.35;
  const meanUncertainty = beliefs.length
    ? beliefs.reduce((sum, belief) => sum + belief.mastery_std, 0) / beliefs.length
    : 0.35;
  const hue = Math.round(245 - meanMastery * 95);
  const nucleusX = clamp((latest?.x ?? 0) * 8, -13, 13);
  const nucleusY = clamp((latest?.y ?? 0) * 8, -13, 13);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className="pointer-events-none absolute bottom-16 left-8 z-40">
      {open && (
        <aside
          id="learner-space"
          className="pointer-events-auto absolute bottom-20 left-0 w-[320px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-indigo-200/70 backdrop-blur-xl dark:bg-zinc-900/95 dark:ring-indigo-800/60"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <span>
              <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">Your learning space</span>
              <span className="block text-[10px] text-zinc-500">Open-vocabulary · probabilistic · Level-2</span>
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close learning space"
              className="grid h-7 w-7 place-items-center rounded-full text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              ×
            </button>
          </div>
          <div className="max-h-[calc(100dvh-180px)] overflow-y-auto px-3 pb-3">
            <div className="mb-1 mt-3 flex items-center justify-between">
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Emergent latent trajectory</h3>
              <span className="text-[9px] text-zinc-400">rotating 3D projection</span>
            </div>
            <LatentTrajectory points={points} />
            <div className="mt-1.5 flex justify-between text-[9px] text-zinc-400">
              <span>{observations} evidence events</span>
              <span>{points.length} latent snapshots</span>
            </div>
            <h3 className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Concept beliefs</h3>
            {beliefs.length ? beliefs.slice(0, 8).map((belief) => (
              <BeliefRow key={belief.name} belief={belief} />
            )) : (
              <p className="rounded-md bg-zinc-50 px-2 py-3 text-[11px] italic text-zinc-500 dark:bg-zinc-950">
                No fixed ability axes. The model discovers concept beliefs as evidence arrives.
              </p>
            )}
            {state?.profile_text && (
              <p className="mt-2 rounded-md bg-emerald-50 px-2 py-2 text-[10px] leading-relaxed text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                {state.profile_text}
              </p>
            )}
            <div className="mt-3 flex items-center justify-between text-[9px] text-zinc-400">
              <span>{snapshot?.adapter_version ?? "adapter-v1"} · {snapshot?.online_step_count ?? 0} online steps</span>
              <span>{snapshot?.rollback_count ?? 0} rollbacks</span>
            </div>
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="mt-2 w-full rounded-md bg-zinc-100 px-2 py-1.5 text-[10px] text-zinc-600 hover:bg-rose-50 hover:text-rose-700 dark:bg-zinc-800"
              >
                Reset learner data
              </button>
            )}
          </div>
        </aside>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="learner-space"
        aria-label="Toggle learning space"
        title="Learner model · click to explore your learning space"
        className="pointer-events-auto group relative grid h-[72px] w-[72px] place-items-center rounded-full outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
      >
        <span
          className="absolute inset-0 animate-[pulse_3s_ease-in-out_infinite] rounded-full blur-lg"
          style={{ backgroundColor: `hsla(${hue}, 82%, 58%, ${0.25 + (1 - meanUncertainty) * 0.2})` }}
        />
        <span className="absolute inset-[5px] animate-[spin_9s_linear_infinite] rounded-full border border-indigo-300/60 border-r-emerald-400/80 dark:border-indigo-500/50 dark:border-r-emerald-300/80">
          <span className="absolute -right-1 top-1/2 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
        </span>
        <span
          className="absolute inset-[10px] overflow-hidden rounded-full border border-white/60 shadow-[inset_-9px_-10px_18px_rgba(30,41,59,.35),inset_7px_7px_15px_rgba(255,255,255,.6),0_8px_24px_rgba(79,70,229,.35)]"
          style={{
            background: `radial-gradient(circle at 33% 27%, rgba(255,255,255,.95) 0 5%, hsla(${hue},90%,72%,.95) 20%, hsla(${hue + 30},78%,48%,.95) 58%, rgba(30,41,59,.96) 100%)`,
          }}
        >
          <span
            className="absolute left-1/2 top-1/2 h-3 w-3 rounded-full bg-white/85 shadow-[0_0_12px_4px_rgba(255,255,255,.65)] transition-transform duration-700"
            style={{ transform: `translate(calc(-50% + ${nucleusX}px), calc(-50% + ${nucleusY}px))` }}
          />
        </span>
        <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-zinc-950 px-1.5 py-0.5 text-center text-[9px] font-semibold text-white shadow dark:bg-white dark:text-zinc-950">
          {observations}
        </span>
        <span className="absolute -bottom-4 whitespace-nowrap text-[9px] font-medium text-zinc-600 opacity-80 transition group-hover:opacity-100 dark:text-zinc-300">
          learner space
        </span>
      </button>
    </div>
  );
}
