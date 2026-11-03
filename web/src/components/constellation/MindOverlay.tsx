"use client";

// "Mind": full-screen learner map over the board. While it is open the board cannot be drawn on,
// and closing it unmounts the scene, so it never renders behind ink.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ProfileHistory } from "@/lib/learner-contracts";
import { LEARNING_DIMENSIONS } from "@/lib/learner-contracts";
import { blend, fromHistory, type MindFrame, type MindLink, type MindMap, type MindNode } from "./map-model";
import type { Level, MindControl } from "./MindScene";
import MindStatic from "./MindStatic";
import { CHROME, PALETTES, STATE_WORDS, THEME_KEY, valueColor, type MindTheme, type Palette } from "./palette";
import { sampleMap } from "./sample";
import { SEEN_KEY } from "./seen";

const MindScene = dynamic(() => import("./MindScene"), { ssr: false, loading: () => <p className="absolute inset-0 grid place-items-center text-sm text-[var(--mind-muted)]">Loading your map…</p> });

const REPLAY_MS = 4500;
// Notes sometimes quote the observation id they cite; the learner sees "that answer" instead.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DIM_WORDS = ["Recall", "Understand", "Apply", "Analyze", "Transfer"];

function prefersStill() {
  if (typeof window === "undefined") return false;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduce) return true;
  try {
    const c = document.createElement("canvas");
    return !(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return true; }
}

export async function loadHistory(signal?: AbortSignal): Promise<ProfileHistory> {
  const response = await fetch("/api/learning/profile/revisions", { cache: "no-store", credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`map ${response.status}`);
  return response.json() as Promise<ProfileHistory>;
}

/** The learner's choice, else Night (dark is the default, 2026-11-03). */
function initialTheme(): MindTheme {
  try { const saved = localStorage.getItem(THEME_KEY); if (saved === "light" || saved === "dark") return saved; } catch { /* storage blocked */ }
  return "dark";
}

const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY) ?? 0); } catch { return 0; } };
const writeSeen = (n: number) => { try { localStorage.setItem(SEEN_KEY, String(n)); } catch { /* storage blocked */ } };

function certainty(n: MindNode) {
  const answers = n.counts.reduce((a, b) => a + b, 0);
  if (n.mean == null) return "not practised yet";
  if (n.weight < 3) return `early read, about ${Math.max(1, answers)} answer${answers === 1 ? "" : "s"}`;
  return `fairly sure, about ${answers} answers`;
}

function Sheet({ node, frame, map, palette, onClose }: { node: MindNode; frame: MindFrame; map: MindMap; palette: Palette; onClose(): void }) {
  const links = frame.links.filter((l) => l.source === node.id || l.target === node.id);
  const evidence = new Set(node.evidence);
  const notes = frame.notes.filter((n) => n.cites.some((c) => evidence.has(c)));
  const events = node.evidence.map((id) => map.events[id]).filter(Boolean).slice(-4).reverse();
  const other = (l: MindLink) => frame.nodes[l.source === node.id ? l.target : l.source]?.label ?? (l.source === node.id ? l.target : l.source);
  return (
    <aside aria-label={`${node.label} evidence`} className="pointer-events-auto absolute bottom-[76px] right-3 top-[76px] w-[min(300px,calc(100%-24px))] overflow-y-auto rounded-2xl border border-[var(--mind-line)] bg-[var(--mind-glass)] p-4 text-[12px] text-[var(--mind-muted)] shadow-2xl backdrop-blur-xl">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold text-[var(--mind-text)]">{node.label}</h3>
          <p className="mt-0.5">{map.regions.find((r) => r.id === node.region)?.label} · {STATE_WORDS[node.state]} · {certainty(node)}{node.due ? " · due for review" : ""}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close evidence" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--mind-line)] text-[var(--mind-text-2)]">✕</button>
      </div>
      <div className="mt-3 space-y-1.5">
        {LEARNING_DIMENSIONS.map((d, i) => {
          const v = node.dims[i];
          return (
            <div key={d} className="flex items-center gap-2">
              <span className="w-[72px]">{DIM_WORDS[i]}</span>
              {v == null ? <span className="text-[var(--mind-faint)]">not tested yet</span> : (
                <>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--mind-track)]"><span className="block h-full rounded-full" style={{ width: `${Math.round(v * 100)}%`, background: valueColor(v, palette) }} /></span>
                  <span className="w-8 text-right text-[var(--mind-text-2)]">{Math.round(v * 100)}%</span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {node.misconceptions.map((m) => (
        <p key={m.id} className={`mt-3 rounded-xl px-3 py-2 ${m.status === "resolved" ? "bg-[var(--mind-good-bg)] text-[var(--mind-good)]" : "bg-[var(--mind-bad-bg)] text-[var(--mind-bad)]"}`}>
          {m.status === "resolved" ? "Fixed: " : m.status === "suspected" ? "Possibly (not yet confirmed): " : "Misconception: "}{m.description.replace(/^On [^:]+: /, "")}
        </p>
      ))}
      {links.length > 0 && <h4 className="mb-1 mt-4 font-semibold text-[var(--mind-text)]">Why it connects</h4>}
      {links.map((l) => {
        const cited = l.evidence.map((id) => map.events[id]).filter(Boolean).slice(0, 2);
        return (
          <div key={`${l.kind}${l.source}${l.target}`} className="mt-2 rounded-xl border border-[var(--mind-line)] px-3 py-2">
            <p className={`text-[11px] ${l.kind === "builds_on" ? "text-[var(--mind-link)]" : "text-[var(--mind-misfire)]"}`}>
              {l.kind === "builds_on" ? (l.source === node.id ? "Led to " : "Builds on ") : "Confused with "}{other(l)} · {l.provenance === "model" ? "written at close, cited" : l.provenance === "system" ? "same wrong belief" : "sample"}
            </p>
            <p className="mt-0.5 text-[var(--mind-text)]">{l.why}</p>
            {cited.map((e) => <p key={e.id} className="mt-1 text-[var(--mind-faint)]">“{e.answer || "(no text)"}” — {e.outcome}</p>)}
          </div>
        );
      })}
      {notes.length > 0 && <h4 className="mb-1 mt-4 font-semibold text-[var(--mind-text)]">Teaching notes</h4>}
      {notes.map((n) => <p key={n.text} className="mt-1">{n.text.replace(UUID, "that answer")}</p>)}
      {events.length > 0 && <h4 className="mb-1 mt-4 font-semibold text-[var(--mind-text)]">Recent answers</h4>}
      {events.map((e) => (
        <div key={e.id} className="mt-1.5">
          <p className="text-[var(--mind-text-2)]">{e.question}</p>
          <p className="text-[var(--mind-faint)]">“{e.answer || "(no text)"}” — {e.outcome} · {e.dimension}</p>
        </div>
      ))}
      {map.sample && <p className="mt-4 text-[var(--mind-faint)]">This is sample data. Your own map appears after your first End session.</p>}
    </aside>
  );
}

export default function MindOverlay({ onClose }: { onClose(): void }) {
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [map, setMap] = useState<MindMap | null>(null);
  const [k, setK] = useState(0);
  const [u, setU] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("brain");
  const [still] = useState(prefersStill);
  const [theme, setTheme] = useState<MindTheme>(initialTheme);
  const [full, setFull] = useState(false);
  const [fullBlocked, setFullBlocked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const palette = PALETTES[theme];
  const switchTheme = () => setTheme((t) => { const next = t === "dark" ? "light" : "dark"; try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ } return next; });
  const canFull = typeof document !== "undefined" && !!document.documentElement.requestFullscreen;
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    // Embedded views (iframes, app panes) may refuse; then the button goes away rather than doing nothing.
    else void root.current?.requestFullscreen?.().catch(() => setFullBlocked(true));
  };
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", sync);
    return () => { document.removeEventListener("fullscreenchange", sync); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); };
  }, []);
  const labels = useRef<Record<string, HTMLElement | null>>({});
  const regionLabels = useRef<Record<string, HTMLElement | null>>({});
  const control = useRef<MindControl | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const raf = useRef(0);
  const mapRef = useRef<MindMap | null>(null);

  const replay = useCallback((to: number) => {
    cancelAnimationFrame(raf.current);
    setK(to);
    if (still || to < 1) { setU(null); return; }
    const target = mapRef.current?.frames[to];
    control.current?.frame(target ? [...new Set([...target.path, ...target.changed])] : []);
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / REPLAY_MS);
      setU(p);
      if (p < 1) raf.current = requestAnimationFrame(step); else setTimeout(() => setU(null), 1200);
    };
    raf.current = requestAnimationFrame(step);
  }, [still]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState("loading");
    try {
      // `?mind=sample` shows the labelled sample even when a profile exists (demo and visual checks).
      const forced = new URLSearchParams(window.location.search).get("mind") === "sample";
      const real = forced ? null : fromHistory(await loadHistory(signal));
      const next = real ?? sampleMap();
      setMap(next);
      mapRef.current = next;
      const last = next.frames.length - 1;
      setK(last);
      setState("ready");
      if (real) {
        const latest = real.frames[last].revision;
        if (latest > readSeen() && last > 0) setTimeout(() => replay(last), 600);
        writeSeen(latest);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") setState("error");
    }
  }, [replay]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal); // eslint-disable-line react-hooks/set-state-in-effect
    closeRef.current?.focus();
    return () => { controller.abort(); cancelAnimationFrame(raf.current); };
  }, [load]);

  const frame = useMemo(() => {
    if (!map) return null;
    const to = map.frames[k];
    return u == null ? to : blend(k ? map.frames[k - 1] : null, to, u);
  }, [map, k, u]);
  const order = useMemo(() => (frame ? Object.values(frame.nodes).sort((a, b) => a.region.localeCompare(b.region) || a.label.localeCompare(b.label)).map((n) => n.id) : []), [frame]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (document.fullscreenElement) return; e.preventDefault(); if (selected) setSelected(null); else onClose(); }
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && order.length && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        const i = selected ? order.indexOf(selected) : -1;
        setSelected(order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1) + (i < 0 ? 1 : 0)) % order.length]);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected, order, onClose]);

  const node = frame && selected ? frame.nodes[selected] : null;
  const last = map ? map.frames.length - 1 : 0;
  const shown = map?.frames[k];
  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Mind" style={CHROME[theme] as CSSProperties} data-theme={theme} className="pointer-events-auto fixed inset-0 z-[1000] overflow-hidden bg-[var(--mind-bg)] text-[var(--mind-text)]" data-mind-map>
      <div className="absolute inset-0">
        {state === "ready" && map && frame && (still
          ? <MindStatic map={map} frame={frame} selected={selected} onSelect={setSelected} palette={palette} />
          : <MindScene key={theme} palette={palette} map={map} frame={frame} replay={u == null || !shown ? null : { path: shown.path, u }} selected={selected}
              onSelect={setSelected} onLevel={setLevel} labels={labels} regionLabels={regionLabels} control={control} />)}
        {state === "loading" && <p className="absolute inset-0 grid place-items-center text-sm text-[var(--mind-muted)]">Loading your map…</p>}
        {state === "error" && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center"><p className="text-sm text-[var(--mind-text-2)]">Couldn&apos;t load your map.</p>
              <button type="button" onClick={() => { void load(); }} className="mt-3 min-h-11 rounded-xl border border-[var(--mind-line)] px-4 text-sm">Retry</button></div>
          </div>
        )}
      </div>
      {!still && frame && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          {Object.values(frame.nodes).map((n) => (
            <span key={n.id} ref={(el) => { labels.current[n.id] = el; }} className="absolute left-0 top-0 whitespace-nowrap text-[12px] text-[var(--mind-text-2)] opacity-0 will-change-transform [text-shadow:0_1px_6px_var(--mind-bg)]" style={{ color: n.mean == null ? palette.unseen : undefined }}>{n.label}</span>
          ))}
        </div>
      )}
      {!still && map && (
        <div className="pointer-events-none absolute inset-0">
          {map.regions.map((r) => (
            <button key={r.id} type="button" ref={(el) => { regionLabels.current[r.id] = el; }} onClick={() => control.current?.flyTo(r.id)}
              className="absolute left-0 top-0 min-h-11 rounded-xl border border-[var(--mind-line)] bg-[var(--mind-glass)] px-3 py-1 text-left opacity-0 will-change-transform">
              <span className="block text-[12px] font-semibold text-[var(--mind-text)]">{r.label}</span>
              <span className="block text-[11px] text-[var(--mind-muted)]">{r.nodes.length} idea{r.nodes.length === 1 ? "" : "s"}</span>
            </button>
          ))}
        </div>
      )}
      <header className="absolute inset-x-3 top-3 flex h-12 items-center gap-2 rounded-2xl border border-[var(--mind-line)] bg-[var(--mind-glass)] px-3 backdrop-blur-xl">
        <span className="whitespace-nowrap text-[15px] font-semibold">Mind</span>
        {shown && <span className="rounded-full border border-[var(--mind-line)] px-2.5 py-0.5 text-[12px] text-[var(--mind-muted)] whitespace-nowrap"><span className="hidden sm:inline">Session {k + 1} · </span>revision {shown.revision}</span>}
        {map?.sample && <span className="rounded-full bg-[var(--mind-good-bg)] px-2.5 py-0.5 text-[12px] text-[var(--mind-good)]">Sample</span>}
        {!still && <span className="hidden rounded-full border border-[var(--mind-line)] px-2.5 py-0.5 text-[12px] text-[var(--mind-muted)] sm:inline">{level === "brain" ? "Whole brain" : level === "region" ? "Region" : "Neurons"}</span>}
        <span className="flex-1" />
        <span className="hidden text-[12px] text-[var(--mind-faint)] md:inline">{still ? "Tap a neuron for its evidence" : "Scroll to zoom · drag to turn · tap a region or neuron"}</span>
        <button type="button" onClick={switchTheme} aria-label={theme === "dark" ? "Switch to light (paper) theme" : "Switch to dark theme"} title={theme === "dark" ? "Paper" : "Night"} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">
          {theme === "dark"
            ? <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></svg>
            : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>}
        </button>
        {canFull && !fullBlocked && (
          <button type="button" onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen" : "Full screen"} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
            </svg>
          </button>
        )}
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close Mind" className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">✕</button>
      </header>
      {node && frame && map && <Sheet node={node} frame={frame} map={map} palette={palette} onClose={() => setSelected(null)} />}
      {map && (
        <footer className="absolute inset-x-3 bottom-3 flex h-12 items-center gap-2 rounded-2xl border border-[var(--mind-line)] bg-[var(--mind-glass)] px-2 backdrop-blur-xl">
          {!still && <>
            <button type="button" aria-label="Zoom out" onClick={() => control.current?.zoom(1 / 1.45)} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">−</button>
            <button type="button" aria-label="Zoom in" onClick={() => control.current?.zoom(1.45)} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">+</button>
            <button type="button" disabled={k < 1} onClick={() => replay(k)} className="h-9 shrink-0 rounded-lg border border-[var(--mind-line)] px-3 text-[13px] disabled:opacity-40">▶ Replay session {k + 1}</button>
          </>}
          <input type="range" min={0} max={last} step={1} value={k} disabled={last < 1} aria-label="Revision"
            onChange={(e) => { cancelAnimationFrame(raf.current); setU(null); setK(Number(e.target.value)); }} className="min-w-0 flex-1 accent-[var(--mind-accent)]" />
          <span className="hidden min-w-[150px] text-right text-[12px] text-[var(--mind-muted)] sm:inline" aria-live="polite">{u != null ? "Replaying…" : shown ? `After session ${k + 1}${shown.changed.length ? ` · ${shown.changed.length} changed` : ""}` : ""}</span>
        </footer>
      )}
    </div>
  );
}
