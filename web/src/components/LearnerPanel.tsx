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
import type {
  ConceptBelief,
  DimensionBelief,
  KnowledgeNode,
  LearnerSnapshot,
  LearningDimensionName,
} from "@/lib/types";

interface Props {
  snapshot: LearnerSnapshot | null;
  onReset?: () => void;
}

interface Point { x: number; y: number }

const ORB_SIZE = 72;
const EDGE = 12;
const STORAGE_KEY = "y_learner_orb_position_v1";
const DIMENSIONS: Array<{
  name: LearningDimensionName;
  label: string;
  color: string;
}> = [
  { name: "understanding", label: "Understanding", color: "#10b981" },
  { name: "knowledge", label: "Knowledge", color: "#3b82f6" },
  { name: "retention", label: "Retention", color: "#8b5cf6" },
  { name: "reasoning", label: "Reasoning", color: "#f59e0b" },
  { name: "application", label: "Application", color: "#f43f5e" },
];

const unresolvedDimension = (): DimensionBelief => ({
  mean: 0.5,
  std: 0.5,
  credible_low: 0,
  credible_high: 1,
  evidence_count: 0,
  status: "insufficient-evidence",
});

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hashId(path: string[]): string {
  let hash = 2166136261;
  for (const char of path.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `kn_${(hash >>> 0).toString(36)}`;
}

function displayConcept(name: string): string {
  return name.replace(/[-_/]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function fallbackDimensions(belief: ConceptBelief): KnowledgeNode["dimensions"] {
  const result = Object.fromEntries(
    DIMENSIONS.map(({ name }) => [name, unresolvedDimension()]),
  ) as KnowledgeNode["dimensions"];
  if (belief.strong_evidence_count > 0) {
    result.understanding = {
      mean: belief.mastery_mean,
      std: belief.mastery_std,
      credible_low: belief.credible_low,
      credible_high: belief.credible_high,
      evidence_count: belief.strong_evidence_count,
      status: "developing",
    };
  }
  return result;
}

/** Client fallback for profiles written before the hierarchical contract. */
export function buildKnowledgeHierarchy(beliefs: ConceptBelief[]): KnowledgeNode[] {
  interface MutableNode {
    name: string;
    path: string[];
    children: Map<string, MutableNode>;
    beliefs: ConceptBelief[];
  }
  const roots = new Map<string, MutableNode>();
  for (const belief of beliefs) {
    const label = belief.display_name || displayConcept(belief.name);
    const rawPath = belief.hierarchy?.length ? belief.hierarchy : ["Interdisciplinary", label];
    const path = rawPath.at(-1)?.toLocaleLowerCase() === label.toLocaleLowerCase()
      ? rawPath : [...rawPath, label];
    let branch = roots;
    const walked: string[] = [];
    for (const part of path.slice(0, 5)) {
      walked.push(part);
      const key = part.toLocaleLowerCase();
      let node = branch.get(key);
      if (!node) {
        node = { name: part, path: [...walked], children: new Map(), beliefs: [] };
        branch.set(key, node);
      }
      node.beliefs.push(belief);
      branch = node.children;
    }
  }

  const serialize = (node: MutableNode, depth: number): KnowledgeNode => {
    const children = [...node.children.values()].map((child) => serialize(child, depth + 1));
    const dimensions = Object.fromEntries(DIMENSIONS.map(({ name }) => {
      const candidates = node.beliefs
        .map((belief) => belief.dimensions?.[name] ?? fallbackDimensions(belief)[name])
        .filter((dimension) => dimension.evidence_count > 0);
      if (!candidates.length) return [name, unresolvedDimension()];
      const total = candidates.reduce((sum, item) => sum + Math.max(1, item.evidence_count), 0);
      const mean = candidates.reduce(
        (sum, item) => sum + item.mean * Math.max(1, item.evidence_count), 0,
      ) / total;
      const std = candidates.reduce(
        (sum, item) => sum + item.std * Math.max(1, item.evidence_count), 0,
      ) / total;
      return [name, {
        mean,
        std,
        credible_low: Math.max(0, mean - 1.96 * std),
        credible_high: Math.min(1, mean + 1.96 * std),
        evidence_count: candidates.reduce((sum, item) => sum + item.evidence_count, 0),
        status: mean <= 0.42 ? "needs-support" : mean >= 0.72 && std < 0.25 ? "well-supported" : "developing",
      } satisfies DimensionBelief];
    })) as KnowledgeNode["dimensions"];
    return {
      id: hashId(node.path),
      name: node.name,
      level: children.length ? ["subject", "field", "subfield", "topic", "subtopic"][Math.min(depth, 4)] : "concept",
      path: node.path,
      children: children.sort((a, b) => b.evidence_count - a.evidence_count),
      concept_names: [...new Set(node.beliefs.map((belief) => belief.name))],
      concept_count: new Set(node.beliefs.map((belief) => belief.name)).size,
      evidence_count: node.beliefs.reduce((sum, belief) => sum + belief.evidence_count, 0),
      dimensions,
    };
  };
  return [...roots.values()].map((node) => serialize(node, 0));
}

function nodeTone(node: KnowledgeNode): { fill: string; stroke: string } {
  const understanding = node.dimensions.understanding;
  if (!understanding || understanding.evidence_count === 0) return { fill: "#64748b", stroke: "#cbd5e1" };
  if (understanding.mean <= 0.42) return { fill: "#e11d48", stroke: "#fda4af" };
  if (understanding.mean >= 0.72 && understanding.std < 0.25) return { fill: "#059669", stroke: "#6ee7b7" };
  return { fill: "#4f46e5", stroke: "#a5b4fc" };
}

function findNode(roots: KnowledgeNode[], path: string[]): KnowledgeNode | undefined {
  let branch = roots;
  let current: KnowledgeNode | undefined;
  for (const part of path) {
    current = branch.find((node) => node.name === part);
    if (!current) return undefined;
    branch = current.children;
  }
  return current;
}

function DimensionBars({ node }: { node?: KnowledgeNode }) {
  if (!node) {
    return <div className="rounded-xl bg-zinc-50 p-3 text-[11px] text-zinc-500 dark:bg-zinc-950/60">Hover or focus a node to inspect its evidence.</div>;
  }
  return (
    <section aria-label={`Learning dimensions for ${node.name}`} className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-950/60">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong className="truncate text-xs text-zinc-800 dark:text-zinc-100">{node.name}</strong>
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-400">{node.level}</span>
      </div>
      <div className="space-y-2">
        {DIMENSIONS.map(({ name, label, color }) => {
          const belief = node.dimensions[name] ?? unresolvedDimension();
          const known = belief.evidence_count > 0;
          return (
            <div key={name} title={known ? `${Math.round(belief.credible_low * 100)}–${Math.round(belief.credible_high * 100)}% credible interval` : "Not enough evidence yet"}>
              <div className="mb-0.5 flex items-center justify-between text-[10px]">
                <span className="font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
                <span className={known ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-400"}>
                  {known ? `${Math.round(belief.mean * 100)}% · ${belief.evidence_count} obs.` : "needs evidence"}
                </span>
              </div>
              <div className="relative h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                {known ? (
                  <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" style={{ width: `${Math.round(belief.mean * 100)}%`, backgroundColor: color }} />
                ) : (
                  <span className="absolute inset-0 opacity-40 [background:repeating-linear-gradient(135deg,transparent,transparent_4px,#94a3b8_4px,#94a3b8_6px)]" />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 truncate text-[9px] text-zinc-400">{node.path.join(" › ")}</div>
    </section>
  );
}

function KnowledgeAtlas({
  roots,
  activeConcepts,
}: {
  roots: KnowledgeNode[];
  activeConcepts: string[];
}) {
  const [path, setPath] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string>();
  const resolvedCurrent = findNode(roots, path);
  const validPath = path.length && !resolvedCurrent ? [] : path;
  const current = validPath.length ? resolvedCurrent : undefined;
  const visible = current?.children ?? roots;
  const preview = visible.find((node) => node.id === previewId) ?? current ?? visible[0];
  const center = { x: 190, y: 122 };

  return (
    <div>
      <nav aria-label="Knowledge hierarchy" className="mb-2 flex min-h-6 items-center gap-1 overflow-x-auto text-[9px]">
        <button type="button" onClick={() => setPath([])} className="shrink-0 rounded bg-indigo-50 px-1.5 py-1 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">All subjects</button>
        {validPath.map((part, index) => (
          <span key={validPath.slice(0, index + 1).join("/")} className="flex items-center gap-1">
            <span className="text-zinc-300">›</span>
            <button type="button" onClick={() => setPath(validPath.slice(0, index + 1))} className="max-w-28 truncate rounded px-1 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">{part}</button>
          </span>
        ))}
      </nav>
      <svg viewBox="0 0 380 245" role="img" aria-label="Hierarchical learner knowledge map" className="h-[245px] w-full rounded-xl bg-[radial-gradient(circle_at_center,rgba(99,102,241,.15),rgba(15,23,42,.02)_68%)] ring-1 ring-indigo-100 dark:ring-indigo-950">
        <defs><filter id="atlas-blur"><feGaussianBlur stdDeviation="5" /></filter></defs>
        {visible.map((node, index) => {
          const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, visible.length);
          const x = center.x + Math.cos(angle) * (visible.length === 1 ? 0 : 132);
          const y = center.y + Math.sin(angle) * (visible.length === 1 ? 0 : 82);
          return <line key={`edge-${node.id}`} x1={center.x} y1={center.y} x2={x} y2={y} stroke="#818cf8" strokeOpacity=".24" strokeWidth="1.5" />;
        })}
        {current && visible.length > 1 && (
          <g>
            <circle cx={center.x} cy={center.y} r="25" fill="#111827" opacity=".92" />
            <text x={center.x} y={center.y + 3} textAnchor="middle" className="fill-white text-[8px] font-semibold">{current.name.slice(0, 20)}</text>
          </g>
        )}
        {visible.map((node, index) => {
          const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, visible.length);
          const x = center.x + Math.cos(angle) * (visible.length === 1 ? 0 : 132);
          const y = center.y + Math.sin(angle) * (visible.length === 1 ? 0 : 82);
          const radius = 15 + Math.min(10, Math.sqrt(Math.max(0, node.evidence_count)) * 2.4);
          const tone = nodeTone(node);
          const uncertainty = node.dimensions.understanding?.std ?? 0.5;
          const active = activeConcepts.some((concept) => node.concept_names.includes(concept));
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.name}, ${node.level}, ${node.children.length ? "open level" : "concept"}`}
              onMouseEnter={() => setPreviewId(node.id)}
              onFocus={() => setPreviewId(node.id)}
              onClick={() => node.children.length ? setPath(node.path) : setPreviewId(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (node.children.length) setPath(node.path); else setPreviewId(node.id);
                }
              }}
              className={`knowledge-node cursor-pointer outline-none ${active ? "knowledge-node-active" : ""}`}
              style={{ transformOrigin: `${x}px ${y}px` }}
            >
              <circle cx={x} cy={y} r={radius + 7 + uncertainty * 18} fill={tone.fill} opacity={0.12 + uncertainty * 0.2} filter="url(#atlas-blur)" />
              <circle cx={x} cy={y} r={radius} fill={tone.fill} stroke={preview?.id === node.id ? "#f8fafc" : tone.stroke} strokeWidth={preview?.id === node.id ? 3 : 1.5} />
              {node.children.length > 0 && <text x={x + radius - 3} y={y - radius + 7} textAnchor="middle" className="fill-white text-[10px] font-bold">+</text>}
              <text x={x} y={y + radius + 13} textAnchor="middle" className="select-none fill-zinc-700 text-[9px] font-medium dark:fill-zinc-200">{node.name.length > 20 ? `${node.name.slice(0, 18)}…` : node.name}</text>
            </g>
          );
        })}
        {!visible.length && <text x="190" y="125" textAnchor="middle" className="fill-zinc-500 text-[10px]">Your knowledge map grows from evidence</text>}
      </svg>
      <p className="my-2 text-[9px] text-zinc-400">Click a node to move from subject → field → topic. Hover or focus to inspect evidence.</p>
      <DimensionBars node={preview} />
    </div>
  );
}

export default function LearnerPanel({ snapshot, onReset }: Props) {
  const [open, setOpen] = useState(false);
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
  const stateBeliefs = state?.concept_beliefs;
  const snapshotBeliefs = snapshot?.concept_beliefs;
  const beliefs = useMemo(
    () => stateBeliefs ?? snapshotBeliefs ?? [],
    [stateBeliefs, snapshotBeliefs],
  );
  const fallbackHierarchy = useMemo(() => buildKnowledgeHierarchy(beliefs), [beliefs]);
  const serverHierarchy = state?.knowledge_hierarchy;
  const hierarchy = serverHierarchy?.length ? serverHierarchy : fallbackHierarchy;
  const observations = state?.observations ?? 0;
  const activity = state?.last_activity;
  const meanUnderstanding = beliefs.length
    ? beliefs.reduce((sum, belief) => sum + belief.mastery_mean, 0) / beliefs.length : 0.35;
  const meanUncertainty = beliefs.length
    ? beliefs.reduce((sum, belief) => sum + belief.mastery_std, 0) / beliefs.length : 0.5;
  const hue = Math.round(245 - meanUnderstanding * 95);

  const clampPosition = useCallback((point: Point): Point => ({
    x: clamp(point.x, EDGE, Math.max(EDGE, window.innerWidth - ORB_SIZE - EDGE)),
    y: clamp(point.y, EDGE, Math.max(EDGE, window.innerHeight - ORB_SIZE - 28)),
  }), []);

  useEffect(() => {
    let stored: Point | undefined;
    try { stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") ?? undefined; } catch { /* ignore malformed local data */ }
    const frame = requestAnimationFrame(() => {
      setPosition(clampPosition(stored ?? { x: 48, y: window.innerHeight - 144 }));
      setReady(true);
    });
    const resize = () => setPosition((current) => clampPosition(current));
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", resize); };
  }, [clampPosition]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const rect = panelRef.current?.getBoundingClientRect();
      const width = rect?.width ?? 420;
      const height = rect?.height ?? 650;
      const gap = 12;
      let x = position.x + ORB_SIZE + gap;
      let y = position.y - Math.min(150, height / 3);
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
  }, [open, position, hierarchy.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const moveTo = (point: Point, persist = false) => {
    const next = clampPosition(point);
    setPosition(next);
    if (persist) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: position, dragged: false };
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.dragged) {
      moveTo({ x: drag.origin.x + event.clientX - drag.startX, y: drag.origin.y + event.clientY - drag.startY }, true);
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
    <div className="pointer-events-none fixed z-40" style={{ left: position.x, top: position.y, opacity: ready ? 1 : 0 }}>
      {open && (
        <aside ref={panelRef} id="learner-space" style={{ left: panelPosition.x, top: panelPosition.y }} className="pointer-events-auto fixed w-[420px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl bg-white/95 shadow-2xl ring-1 ring-indigo-200/70 backdrop-blur-xl dark:bg-zinc-900/95 dark:ring-indigo-800/60">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <span>
              <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">Your knowledge atlas</span>
              <span className="block text-[10px] text-zinc-500">Hierarchical · probabilistic · evidence-aware</span>
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close learning space" className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">×</button>
          </div>
          <div className="max-h-[calc(100dvh-110px)] overflow-y-auto px-3 pb-3">
            <div className="mb-2 mt-3 flex items-center justify-between text-[9px] text-zinc-400">
              <span>size = evidence · halo = uncertainty</span>
              <span>revision {state?.revision ?? 0}</span>
            </div>
            <KnowledgeAtlas roots={hierarchy} activeConcepts={activity?.concepts ?? []} />
            <div className="mt-2 rounded-lg border border-zinc-100 px-2 py-1.5 text-[9px] text-zinc-500 dark:border-zinc-800">
              <div className="font-semibold uppercase tracking-wide text-zinc-400">Adaptation activity</div>
              <div className="mt-1 flex justify-between"><span>representation {state?.adapter.representation_steps ?? 0}</span><span>mastery {state?.adapter.online_steps ?? 0}</span><span>rollbacks {(state?.adapter.representation_rollbacks ?? 0) + (state?.adapter.rollback_count ?? 0)}</span></div>
              {!state?.adapter.trained_checkpoint && <div className="mt-1 text-amber-700 dark:text-amber-300">Bayesian mode · neural base not promoted</div>}
            </div>
            {state?.profile_text && <p className="mt-2 rounded-md bg-emerald-50 px-2 py-2 text-[10px] leading-relaxed text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{state.profile_text}</p>}
            <div className="mt-2 text-[9px] text-zinc-400">{observations} events · {hierarchy.length} subject areas</div>
            {onReset && <button type="button" onClick={onReset} className="mt-2 w-full rounded-md bg-zinc-100 px-2 py-1.5 text-[10px] text-zinc-600 hover:bg-rose-50 hover:text-rose-700 dark:bg-zinc-800">Reset learner data</button>}
          </div>
        </aside>
      )}
      <button
        type="button"
        onClick={() => { if (!suppressClick.current) setOpen((value) => !value); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        aria-expanded={open}
        aria-controls="learner-space"
        aria-label="Open learner knowledge atlas; drag to move"
        title="Drag learner orb · click to explore"
        className="pointer-events-auto group relative grid h-[72px] w-[72px] touch-none place-items-center rounded-full outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 motion-reduce:transition-none"
      >
        <span className="absolute inset-0 animate-[pulse_3s_ease-in-out_infinite] rounded-full blur-lg motion-reduce:animate-none" style={{ backgroundColor: `hsla(${hue},82%,58%,${0.25 + (1 - meanUncertainty) * 0.2})` }} />
        <span className="absolute inset-[5px] animate-[spin_9s_linear_infinite] rounded-full border border-indigo-300/60 border-r-emerald-400/80 motion-reduce:animate-none dark:border-indigo-500/50 dark:border-r-emerald-300/80"><span className="absolute -right-1 top-1/2 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" /></span>
        <span className="absolute inset-[10px] overflow-hidden rounded-full border border-white/60 shadow-[inset_-9px_-10px_18px_rgba(30,41,59,.35),inset_7px_7px_15px_rgba(255,255,255,.6),0_8px_24px_rgba(79,70,229,.35)]" style={{ background: `radial-gradient(circle at 33% 27%,rgba(255,255,255,.95) 0 5%,hsla(${hue},90%,72%,.95) 20%,hsla(${hue + 30},78%,48%,.95) 58%,rgba(30,41,59,.96) 100%)` }}><span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/85 shadow-[0_0_12px_4px_rgba(255,255,255,.65)]" /></span>
        <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-zinc-950 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow dark:bg-white dark:text-zinc-950">{observations}</span>
        <span className="absolute -bottom-4 whitespace-nowrap text-[9px] font-medium text-zinc-600 opacity-80 dark:text-zinc-300">knowledge atlas</span>
      </button>
    </div>
  );
}
