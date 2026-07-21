"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConceptBelief, ConceptRelation, LearnerSnapshot } from "@/lib/types";

interface Props {
  snapshot: LearnerSnapshot | null;
  onReset?: () => void;
}

interface Point { x: number; y: number }
export interface ConstellationNode extends Point {
  belief: ConceptBelief;
  radius: number;
}

const ORB_SIZE = 72;
const EDGE = 12;
const STORAGE_KEY = "y_learner_orb_position_v1";

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/** Deterministic force layout: stable names move smoothly when relations change. */
export function buildConstellationLayout(
  beliefs: ConceptBelief[],
  relations: ConceptRelation[],
  width = 292,
  height = 220,
): ConstellationNode[] {
  const center = { x: width / 2, y: height / 2 };
  const nodes = beliefs.slice(0, 12).map((belief, index) => {
    const angle = hashUnit(belief.name) * Math.PI * 2;
    const ring = 46 + (index % 3) * 24 + hashUnit(`${belief.name}:r`) * 14;
    return {
      belief,
      x: center.x + Math.cos(angle) * ring,
      y: center.y + Math.sin(angle) * ring * 0.72,
      radius: 8 + Math.min(10, Math.sqrt(Math.max(0, belief.evidence_count)) * 2.8),
    };
  });
  const byName = new Map(nodes.map((node, index) => [node.belief.name, index]));
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const force = nodes.map(() => ({ x: 0, y: 0 }));
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const dx = nodes[right].x - nodes[left].x || 0.1;
        const dy = nodes[right].y - nodes[left].y || 0.1;
        const distance2 = Math.max(40, dx * dx + dy * dy);
        const push = 150 / distance2;
        force[left].x -= dx * push;
        force[left].y -= dy * push;
        force[right].x += dx * push;
        force[right].y += dy * push;
      }
    }
    for (const relation of relations) {
      const left = byName.get(relation.source);
      const right = byName.get(relation.target);
      if (left == null || right == null) continue;
      const dx = nodes[right].x - nodes[left].x;
      const dy = nodes[right].y - nodes[left].y;
      const pull = 0.004 + relation.strength * 0.008;
      force[left].x += dx * pull;
      force[left].y += dy * pull;
      force[right].x -= dx * pull;
      force[right].y -= dy * pull;
    }
    nodes.forEach((node, index) => {
      node.x = clamp(node.x + force[index].x + (center.x - node.x) * 0.006, 30, width - 30);
      node.y = clamp(node.y + force[index].y + (center.y - node.y) * 0.006, 30, height - 30);
    });
  }
  return nodes;
}

function conceptTone(belief: ConceptBelief): { label: string; fill: string; stroke: string } {
  if (belief.strong_evidence_count === 0) {
    return { label: "unresolved", fill: "#94a3b8", stroke: "#cbd5e1" };
  }
  if (belief.mastery_mean <= 0.42) {
    return { label: "needs support", fill: "#f43f5e", stroke: "#fda4af" };
  }
  if (belief.mastery_mean >= 0.72 && belief.mastery_std < 0.22) {
    return { label: "transfer-ready", fill: "#10b981", stroke: "#6ee7b7" };
  }
  return { label: "developing", fill: "#6366f1", stroke: "#a5b4fc" };
}

function ConceptConstellation({
  beliefs,
  relations,
  activeConcepts,
  selected,
  onSelect,
}: {
  beliefs: ConceptBelief[];
  relations: ConceptRelation[];
  activeConcepts: string[];
  selected?: string;
  onSelect: (name: string) => void;
}) {
  const nodes = useMemo(
    () => buildConstellationLayout(beliefs, relations),
    [beliefs, relations],
  );
  const byName = new Map(nodes.map((node) => [node.belief.name, node]));
  return (
    <svg
      viewBox="0 0 292 220"
      role="img"
      aria-label="Live concept constellation"
      className="h-[220px] w-full overflow-visible rounded-xl bg-[radial-gradient(circle_at_center,rgba(99,102,241,.12),rgba(15,23,42,.02)_66%)] ring-1 ring-indigo-100 dark:ring-indigo-950"
    >
      <defs>
        <filter id="constellation-blur"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      {relations.map((relation) => {
        const source = byName.get(relation.source);
        const target = byName.get(relation.target);
        if (!source || !target) return null;
        const active = activeConcepts.includes(relation.source) || activeConcepts.includes(relation.target);
        return (
          <line
            key={`${relation.source}:${relation.target}`}
            x1={source.x} y1={source.y} x2={target.x} y2={target.y}
            stroke={active ? "#34d399" : "#818cf8"}
            strokeWidth={0.7 + relation.strength * 2.1}
            strokeOpacity={active ? 0.85 : 0.2 + relation.strength * 0.35}
            strokeDasharray={relation.kind === "semantic" ? "3 4" : undefined}
            className={active ? "constellation-edge-active" : ""}
          />
        );
      })}
      {nodes.map((node) => {
        const tone = conceptTone(node.belief);
        const active = activeConcepts.includes(node.belief.name);
        const chosen = selected === node.belief.name;
        const halo = node.radius + 6 + node.belief.mastery_std * 24;
        return (
          <g
            key={node.belief.name}
            role="button"
            tabIndex={0}
            aria-label={`${node.belief.name}, ${tone.label}`}
            onClick={() => onSelect(node.belief.name)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onSelect(node.belief.name);
            }}
            className={`constellation-node cursor-pointer outline-none ${active ? "constellation-node-active" : ""}`}
            style={{ transformOrigin: `${node.x}px ${node.y}px` }}
          >
            <circle cx={node.x} cy={node.y} r={halo} fill={tone.fill} opacity={0.12 + node.belief.mastery_std * 0.32} filter="url(#constellation-blur)" />
            <circle cx={node.x} cy={node.y} r={node.radius + (chosen ? 3 : 0)} fill={tone.fill} stroke={chosen ? "#f8fafc" : tone.stroke} strokeWidth={chosen ? 3 : 1.5} />
            <circle cx={node.x - node.radius * 0.28} cy={node.y - node.radius * 0.3} r={Math.max(2, node.radius * 0.22)} fill="white" opacity=".55" />
            <text x={node.x} y={node.y + node.radius + 13} textAnchor="middle" className="select-none fill-zinc-700 text-[9px] font-medium dark:fill-zinc-200">
              {node.belief.name.length > 23 ? `${node.belief.name.slice(0, 21)}…` : node.belief.name}
            </text>
          </g>
        );
      })}
      {!nodes.length && (
        <text x="146" y="112" textAnchor="middle" className="fill-zinc-500 text-[10px]">
          Concepts appear as you interact
        </text>
      )}
    </svg>
  );
}

export default function LearnerPanel({ snapshot, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState<string>();
  const [position, setPosition] = useState<Point>({ x: 48, y: 520 });
  const [panelPosition, setPanelPosition] = useState<Point>({ x: 132, y: 120 });
  const [ready, setReady] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: Point;
    dragged: boolean;
  } | undefined>(undefined);
  const suppressClick = useRef(false);

  const state = snapshot?.learner_state;
  const beliefs = state?.concept_beliefs ?? snapshot?.concept_beliefs ?? [];
  const relations = state?.concept_relations ?? [];
  const observations = state?.observations ?? 0;
  const activity = state?.last_activity;
  const selected = beliefs.find((belief) => belief.name === selectedName) ?? beliefs[0];
  const meanMastery = beliefs.length
    ? beliefs.reduce((sum, belief) => sum + belief.mastery_mean, 0) / beliefs.length
    : 0.35;
  const meanUncertainty = beliefs.length
    ? beliefs.reduce((sum, belief) => sum + belief.mastery_std, 0) / beliefs.length
    : 0.35;
  const hue = Math.round(245 - meanMastery * 95);

  const clampPosition = useCallback((point: Point): Point => ({
    x: clamp(point.x, EDGE, Math.max(EDGE, window.innerWidth - ORB_SIZE - EDGE)),
    y: clamp(point.y, EDGE, Math.max(EDGE, window.innerHeight - ORB_SIZE - 28)),
  }), []);

  useEffect(() => {
    let stored: Point | undefined;
    try { stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") ?? undefined; } catch { /* ignored */ }
    const frame = requestAnimationFrame(() => {
      setPosition(clampPosition(stored ?? { x: 48, y: window.innerHeight - 144 }));
      setReady(true);
    });
    const resize = () => setPosition((current) => clampPosition(current));
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [clampPosition]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const rect = panelRef.current?.getBoundingClientRect();
      const width = rect?.width ?? 320;
      const height = rect?.height ?? 520;
      const gap = 12;
      let x = position.x + ORB_SIZE + gap;
      let y = position.y - Math.min(120, height / 3);
      if (x + width > window.innerWidth - EDGE) x = position.x - width - gap;
      if (x < EDGE) {
        x = clamp(position.x + ORB_SIZE / 2 - width / 2, EDGE, window.innerWidth - width - EDGE);
        y = position.y > height + gap ? position.y - height - gap : position.y + ORB_SIZE + gap;
      }
      setPanelPosition({
        x: clamp(x, EDGE, Math.max(EDGE, window.innerWidth - width - EDGE)),
        y: clamp(y, EDGE, Math.max(EDGE, window.innerHeight - height - EDGE)),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, position, beliefs.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const moveTo = (point: Point, persist = false) => {
    const next = clampPosition(point);
    setPosition(next);
    if (persist) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      dragged: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragged && Math.hypot(dx, dy) < 6) return;
    drag.dragged = true;
    suppressClick.current = true;
    moveTo({ x: drag.origin.x + dx, y: drag.origin.y + dy });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.dragged) {
      moveTo({
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      }, true);
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const movement: Record<string, Point> = {
      ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 },
      ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 },
    };
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    moveTo({ x: position.x + delta.x, y: position.y + delta.y }, true);
  };

  return (
    <div
      className="pointer-events-none fixed z-40"
      style={{ left: position.x, top: position.y, opacity: ready ? 1 : 0 }}
    >
      {open && (
        <aside
          ref={panelRef}
          id="learner-space"
          style={{ left: panelPosition.x, top: panelPosition.y }}
          className="pointer-events-auto fixed w-[320px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-indigo-200/70 backdrop-blur-xl dark:bg-zinc-900/95 dark:ring-indigo-800/60"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <span>
              <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">Your learning constellation</span>
              <span className="block text-[10px] text-zinc-500">Open-vocabulary · probabilistic · live</span>
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close learning space" className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">×</button>
          </div>
          <div className="max-h-[calc(100dvh-130px)] overflow-y-auto px-3 pb-3">
            <div className="mb-1.5 mt-3 flex items-center justify-between text-[9px] text-zinc-400">
              <span>size = evidence · halo = uncertainty</span>
              <span>revision {state?.revision ?? 0}</span>
            </div>
            <ConceptConstellation
              beliefs={beliefs}
              relations={relations}
              activeConcepts={activity?.concepts ?? []}
              selected={selected?.name}
              onSelect={setSelectedName}
            />
            <div className="mt-2 flex flex-wrap gap-1.5 text-[9px]">
              {[
                ["#94a3b8", "unresolved"], ["#f43f5e", "needs support"],
                ["#6366f1", "developing"], ["#10b981", "transfer-ready"],
              ].map(([color, label]) => <span key={label} className="flex items-center gap-1 text-zinc-500"><i className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>)}
            </div>
            {selected && (
              <section className="mt-2 rounded-xl bg-zinc-50 p-2.5 text-[10px] dark:bg-zinc-950/60">
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-[11px] text-zinc-800 dark:text-zinc-100">{selected.name}</strong>
                  <span className="shrink-0 text-zinc-500">{conceptTone(selected).label}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-500">
                  <span>belief {Math.round(selected.mastery_mean * 100)}%</span>
                  <span>95% interval {Math.round(selected.credible_low * 100)}–{Math.round(selected.credible_high * 100)}%</span>
                  <span>{selected.strong_evidence_count} assessed</span>
                  <span>{selected.help_evidence_count} help events</span>
                  <span>trend {selected.trend > .05 ? "rising" : selected.trend < -.05 ? "falling" : "steady"}</span>
                  <span>{selected.last_evidence_at ? new Date(selected.last_evidence_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "no update yet"}</span>
                </div>
                {selected.misconception && <p className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">Misconception: {selected.misconception}</p>}
              </section>
            )}
            <div className="mt-2 rounded-lg border border-zinc-100 px-2 py-1.5 text-[9px] text-zinc-500 dark:border-zinc-800">
              <div className="font-semibold uppercase tracking-wide text-zinc-400">Adaptation activity</div>
              <div className="mt-1 flex justify-between"><span>representation {state?.adapter.representation_steps ?? 0}</span><span>mastery {state?.adapter.online_steps ?? 0}</span><span>rollbacks {(state?.adapter.representation_rollbacks ?? 0) + (state?.adapter.rollback_count ?? 0)}</span></div>
              {!state?.adapter.trained_checkpoint && <div className="mt-1 text-amber-700 dark:text-amber-300">Bayesian mode · neural base not promoted</div>}
            </div>
            {state?.profile_text && <p className="mt-2 rounded-md bg-emerald-50 px-2 py-2 text-[10px] leading-relaxed text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{state.profile_text}</p>}
            <div className="mt-2 text-[9px] text-zinc-400">{observations} events · {relations.length} live relations</div>
            {onReset && <button type="button" onClick={onReset} className="mt-2 w-full rounded-md bg-zinc-100 px-2 py-1.5 text-[10px] text-zinc-600 hover:bg-rose-50 hover:text-rose-700 dark:bg-zinc-800">Reset learner data</button>}
          </div>
        </aside>
      )}

      <button
        type="button"
        onClick={() => {
          if (!suppressClick.current) setOpen((value) => !value);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        aria-expanded={open}
        aria-controls="learner-space"
        aria-label="Open learning constellation; drag to move"
        title="Drag learner orb · click to explore"
        className="pointer-events-auto group relative grid h-[72px] w-[72px] touch-none place-items-center rounded-full outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none"
      >
        <span className="absolute inset-0 animate-[pulse_3s_ease-in-out_infinite] rounded-full blur-lg motion-reduce:animate-none" style={{ backgroundColor: `hsla(${hue},82%,58%,${0.25 + (1 - meanUncertainty) * 0.2})` }} />
        <span className="absolute inset-[5px] animate-[spin_9s_linear_infinite] rounded-full border border-indigo-300/60 border-r-emerald-400/80 motion-reduce:animate-none dark:border-indigo-500/50 dark:border-r-emerald-300/80"><span className="absolute -right-1 top-1/2 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" /></span>
        <span className="absolute inset-[10px] overflow-hidden rounded-full border border-white/60 shadow-[inset_-9px_-10px_18px_rgba(30,41,59,.35),inset_7px_7px_15px_rgba(255,255,255,.6),0_8px_24px_rgba(79,70,229,.35)]" style={{ background: `radial-gradient(circle at 33% 27%,rgba(255,255,255,.95) 0 5%,hsla(${hue},90%,72%,.95) 20%,hsla(${hue + 30},78%,48%,.95) 58%,rgba(30,41,59,.96) 100%)` }}>
          <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/85 shadow-[0_0_12px_4px_rgba(255,255,255,.65)]" />
        </span>
        <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-zinc-950 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow dark:bg-white dark:text-zinc-950">{observations}</span>
        <span className="absolute -bottom-4 whitespace-nowrap text-[9px] font-medium text-zinc-600 opacity-80 dark:text-zinc-300">learner space</span>
      </button>
    </div>
  );
}
