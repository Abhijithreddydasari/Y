"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { UMAP } from "umap-js";
import type { LearnerSession, LearnerSnapshot } from "@/lib/types";

interface Props {
  snapshot: LearnerSnapshot | null;
  onReset?: () => void;
}

interface ConceptCount {
  concept: string;
  seen: number;
  mastered: number;
  struggling: number;
}

const PANEL_W = 280;

/** Reduce session embeddings to 3D points so the panel can render a tiny
 *  rotating scatter. With < 3 sessions UMAP is unstable, so we lay sessions
 *  out on a circle in the xy-plane (z=0) and let the rest of the viz handle
 *  the chronological coloring. */
function projectTo3D(sessions: LearnerSession[]): [number, number, number][] {
  const withEmb = sessions.filter((s) => Array.isArray(s.embedding) && s.embedding.length > 0);
  if (withEmb.length === 0) return [];
  if (withEmb.length < 4) {
    return withEmb.map((_s, i) => {
      const a = (i / Math.max(1, withEmb.length)) * Math.PI * 2;
      return [Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0] as [number, number, number];
    });
  }
  const dims = withEmb[0].embedding!.length;
  // Normalise to unit vectors so UMAP's distance metric is well-conditioned.
  const X = withEmb.map((s) => {
    const v = s.embedding!.slice(0, dims);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return v.map((x) => x / norm);
  });
  try {
    const umap = new UMAP({
      nComponents: 3,
      nNeighbors: Math.min(15, X.length - 1),
      minDist: 0.1,
      spread: 1.0,
    });
    const out = umap.fit(X);
    // Centre & rescale to roughly the unit cube.
    let cx = 0, cy = 0, cz = 0;
    for (const [x, y, z] of out as number[][]) {
      cx += x; cy += y; cz += z;
    }
    const n = out.length;
    cx /= n; cy /= n; cz /= n;
    let max = 0.001;
    const centered = (out as number[][]).map(([x, y, z]) => {
      const a = x - cx, b = y - cy, c = z - cz;
      max = Math.max(max, Math.abs(a), Math.abs(b), Math.abs(c));
      return [a, b, c] as [number, number, number];
    });
    return centered.map(([x, y, z]) => [x / max, y / max, z / max] as [number, number, number]);
  } catch (exc) {
    console.warn("[learner-panel] UMAP failed; fallback layout", exc);
    return withEmb.map((_s, i) => {
      const a = (i / Math.max(1, withEmb.length)) * Math.PI * 2;
      return [Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0] as [number, number, number];
    });
  }
}

function aggregateConcepts(sessions: LearnerSession[]): ConceptCount[] {
  const m = new Map<string, ConceptCount>();
  for (const s of sessions) {
    for (const c of s.concepts_seen ?? []) {
      const r = m.get(c) ?? { concept: c, seen: 0, mastered: 0, struggling: 0 };
      r.seen += 1;
      m.set(c, r);
    }
    for (const c of s.mastered ?? []) {
      const r = m.get(c) ?? { concept: c, seen: 0, mastered: 0, struggling: 0 };
      r.mastered += 1;
      m.set(c, r);
    }
    for (const c of s.struggling ?? []) {
      const r = m.get(c) ?? { concept: c, seen: 0, mastered: 0, struggling: 0 };
      r.struggling += 1;
      m.set(c, r);
    }
  }
  return Array.from(m.values()).sort((a, b) => b.seen - a.seen).slice(0, 6);
}

/**
 * Auto-rotating 3D scatter rendered on a canvas. We project sessions to 3D
 * via UMAP, then orbit the camera around y so the user sees the concept
 * trail from multiple angles without needing manual controls. Latest session
 * is highlighted; older ones fade. Adjacent-in-time sessions are connected
 * by a faint line so the trail is legible.
 */
function ConceptScatter({ sessions }: { sessions: LearnerSession[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const points3D = useMemo(() => projectTo3D(sessions), [sessions]);
  // Filter to the same sessions UMAP saw (those with embeddings).
  const labelledSessions = useMemo(
    () => sessions.filter((s) => Array.isArray(s.embedding) && s.embedding.length > 0),
    [sessions],
  );
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = PANEL_W - 24;
    const H = 180;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let angle = 0.6;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      // Subtle ground.
      ctx.fillStyle = "rgba(99,102,241,0.04)";
      ctx.fillRect(0, 0, W, H);

      const cx = W / 2;
      const cy = H / 2 + 8;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const tiltSin = Math.sin(0.45);
      const tiltCos = Math.cos(0.45);
      const scale = 60;
      const fov = 320;

      const projected = points3D.map(([x, y, z]) => {
        // Rotate around y, then tilt around x.
        const xr = x * cos - z * sin;
        const zr = x * sin + z * cos;
        const yr = y * tiltCos - zr * tiltSin;
        const zr2 = y * tiltSin + zr * tiltCos;
        const persp = fov / (fov + zr2 * scale);
        return {
          x: cx + xr * scale * persp,
          y: cy + yr * scale * persp,
          z: zr2,
          persp,
        };
      });

      // Trail (chronological line through projected points).
      ctx.strokeStyle = "rgba(99,102,241,0.55)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < projected.length; i++) {
        const p = projected[i];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      // Points (sorted by depth so far points draw first).
      const order = projected.map((p, i) => ({ p, i })).sort((a, b) => a.p.z - b.p.z);
      for (const { p, i } of order) {
        const isLatest = i === labelledSessions.length - 1;
        const isHover = hovered === i;
        const r = (isLatest ? 6 : 4) * p.persp;
        const t = labelledSessions.length > 1 ? i / (labelledSessions.length - 1) : 1;
        const hue = 240 - 100 * t;
        const sat = 70 + 20 * t;
        const lum = isLatest ? 50 : 35 + t * 10;
        ctx.fillStyle = isHover
          ? "#f59e0b"
          : `hsla(${hue}, ${sat}%, ${lum}%, ${0.5 + 0.5 * p.persp})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (isLatest) {
          ctx.strokeStyle = "rgba(16,185,129,0.9)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      angle += 0.005;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [points3D, labelledSessions.length, hovered]);

  if (labelledSessions.length === 0) {
    return (
      <p className="px-3 py-3 text-[12px] italic text-zinc-500 dark:text-zinc-400">
        Run a lesson to see this learner&apos;s knowledge map start filling in.
      </p>
    );
  }
  const hoveredSession = hovered != null ? labelledSessions[hovered] : null;
  return (
    <div className="px-3 pb-2">
      <canvas ref={canvasRef} className="w-full rounded-md bg-zinc-50 ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-800" />
      <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
        <span>{labelledSessions.length} sessions</span>
        <span>{hoveredSession ? hoveredSession.topic || "session" : "trail = chronological"}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {labelledSessions.map((s, i) => (
          <button
            type="button"
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            className={`rounded-full px-2 py-0.5 text-[9px] ${
              hovered === i
                ? "bg-amber-100 text-amber-800"
                : i === labelledSessions.length - 1
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
            title={s.summary || s.topic}
          >
            {s.topic || `s${i + 1}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConceptBars({ rows }: { rows: ConceptCount[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5 px-3 py-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Concept mastery
      </h3>
      {rows.map((r) => {
        const total = Math.max(1, r.mastered + r.struggling + Math.max(0, r.seen - r.mastered - r.struggling));
        const mPct = (r.mastered / total) * 100;
        const sPct = (r.struggling / total) * 100;
        return (
          <div key={r.concept}>
            <div className="flex justify-between text-[10px] text-zinc-600 dark:text-zinc-300">
              <span className="truncate">{r.concept}</span>
              <span className="ml-2 text-zinc-400">{r.seen}x</span>
            </div>
            <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className="bg-emerald-500" style={{ width: `${mPct}%` }} />
              <div className="bg-rose-400" style={{ width: `${sPct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function LearnerPanel({ snapshot, onReset }: Props) {
  const [open, setOpen] = useState(true);
  const sessions = snapshot?.sessions ?? [];
  const concepts = useMemo(() => aggregateConcepts(sessions), [sessions]);

  return (
    <div className="pointer-events-none absolute bottom-12 left-4 z-30 flex max-h-[80vh] flex-col items-start gap-2">
      <div className="pointer-events-auto overflow-y-auto rounded-2xl bg-white/95 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10" style={{ width: PANEL_W }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-t-2xl px-3 py-2 text-left text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <span>Learner profile</span>
          <span aria-hidden className="text-xs text-zinc-500">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            {sessions.length === 0 ? (
              <p className="px-3 py-3 text-[12px] italic text-zinc-500 dark:text-zinc-400">
                Y is meeting you for the first time. Ask three questions and watch the map below light up.
              </p>
            ) : (
              <>
                <ConceptScatter sessions={sessions} />
                <ConceptBars rows={concepts} />
                {onReset && (
                  <div className="border-t border-zinc-100 px-3 py-1.5 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={onReset}
                      className="text-[10px] text-zinc-400 hover:text-rose-500"
                    >
                      reset profile
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
