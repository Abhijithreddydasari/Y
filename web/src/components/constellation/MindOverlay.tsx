"use client";

// "Mind": full-screen learner map over the board. While it is open the board cannot be drawn on,
// and closing it unmounts the scene, so it never renders behind ink.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { NodeState, ProfileHistory } from "@/lib/learner-contracts";
import { LEARNING_DIMENSIONS } from "@/lib/learner-contracts";
import { blend, fromHistory, type MindFrame, type MindLink, type MindMap, type MindNode } from "./map-model";
import type { Level, MindControl } from "./MindScene";
import MindStatic from "./MindStatic";
import { CHROME, PALETTES, STATE_MEANINGS, STATE_WORDS, THEME_KEY, stateColor, valueColor, type MindTheme, type Palette } from "./palette";
import { sampleMap } from "./sample";
import { SEEN_KEY } from "./seen";

const MindScene = dynamic(() => import("./MindScene"), { ssr: false, loading: () => <p className="absolute inset-0 grid place-items-center text-sm text-[var(--mind-muted)]">Loading your map…</p> });

const REPLAY_MS = 4500;
// Notes sometimes quote the observation id they cite; the learner sees "that answer" instead.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DIM_WORDS = ["Recall", "Understand", "Apply", "Analyze", "Transfer"];
/** The legend's chips: a count of the learner's neurons in each state, and a filter. */
const CHIPS: { state: NodeState; name: string }[] = [
  { state: "solid", name: "Solid" }, { state: "learning", name: "Learning" }, { state: "shaky", name: "Shaky" }, { state: "misconception", name: "Wrong belief" },
];
/** Search flies to its matches only when they are few enough to be what the learner meant. */
const FLY_TO_MATCHES = 3;

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
    <aside aria-label={`${node.label} evidence`} className="pointer-events-auto absolute bottom-[124px] right-3 top-[76px] w-[min(300px,calc(100%-24px))] overflow-y-auto rounded-2xl border border-[var(--mind-line)] bg-[var(--mind-glass)] p-4 text-[12px] text-[var(--mind-muted)] shadow-2xl backdrop-blur-xl">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold text-[var(--mind-text)]">{node.label}</h3>
          <p className="mt-0.5">{map.regions.find((r) => r.id === node.region)?.label} · {STATE_WORDS[node.state]} · {certainty(node)}{node.due ? " · due for review" : ""}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close evidence" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--mind-line)] text-[var(--mind-text-2)]">✕</button>
      </div>
      <p className="mt-3 rounded-xl bg-[var(--mind-track)] px-3 py-2 text-[var(--mind-text)]">{STATE_MEANINGS[node.state]}</p>
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
              {l.kind === "builds_on" ? (l.source === node.id ? "Led to " : "Builds on ") : "Confused with "}{other(l)} · {l.provenance === "model" ? "written at close, cited" : l.provenance === "system" ? "same wrong belief" : l.provenance === "seed" ? "seeded demo history" : "sample"}
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
  const [filter, setFilter] = useState<NodeState | null>(null);
  const [query, setQuery] = useState("");
  const [showChanged, setShowChanged] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const palette = PALETTES[theme];
  const switchTheme = () => setTheme((t) => { const next = t === "dark" ? "light" : "dark"; try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ } return next; });
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

  // What a filter, search or the "changed" button keeps lit. Null means nothing is narrowing the map.
  const asked = query.trim().toLowerCase();
  const changedIds = map?.frames[k]?.changed;
  const focus = useMemo(() => {
    if (!frame || (!filter && !asked && !showChanged)) return null;
    const changed = new Set(changedIds);
    return new Set(Object.values(frame.nodes).filter((n) => (!filter || n.state === filter)
      && (!asked || n.label.toLowerCase().includes(asked)) && (!showChanged || changed.has(n.id))).map((n) => n.id));
  }, [frame, filter, asked, showChanged, changedIds]);
  // A search narrow enough to mean something flies there.
  const flyTo = asked && focus && focus.size > 0 && focus.size <= FLY_TO_MATCHES ? [...focus].sort().join("|") : "";
  useEffect(() => { if (flyTo) control.current?.frame(flyTo.split("|")); }, [flyTo]);
  const counts = useMemo(() => {
    const out: Partial<Record<NodeState, number>> = {};
    for (const n of Object.values(frame?.nodes ?? {})) out[n.state] = (out[n.state] ?? 0) + 1;
    return out;
  }, [frame]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (selected) setSelected(null); else onClose(); }
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
    <div role="dialog" aria-modal="true" aria-label="Mind" style={CHROME[theme] as CSSProperties} data-theme={theme} className="pointer-events-auto fixed inset-0 z-[1000] overflow-hidden bg-[var(--mind-bg)] text-[var(--mind-text)]" data-mind-map>
      <div className="absolute inset-0">
        {state === "ready" && map && frame && (still
          ? <MindStatic map={map} frame={frame} selected={selected} onSelect={setSelected} palette={palette} focus={focus} />
          : <MindScene key={theme} palette={palette} map={map} frame={frame} focus={focus} replay={u == null || !shown ? null : { path: shown.path, u }} selected={selected}
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
        {shown && <span className="hidden rounded-full border border-[var(--mind-line)] px-2.5 py-0.5 text-[12px] text-[var(--mind-muted)] whitespace-nowrap sm:inline">Session {k + 1}</span>}
        {map?.sample && <span className="rounded-full bg-[var(--mind-good-bg)] px-2.5 py-0.5 text-[12px] text-[var(--mind-good)]">Sample</span>}
        {!still && <span className="hidden rounded-full border border-[var(--mind-line)] px-2.5 py-0.5 text-[12px] text-[var(--mind-muted)] sm:inline">{level === "brain" ? "Whole brain" : level === "region" ? "Region" : "Neurons"}</span>}
        <span className="flex-1" />
        <label className="flex h-9 min-w-0 flex-[0_1_260px] items-center gap-1.5 rounded-lg border border-[var(--mind-line)] px-2.5">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-[var(--mind-muted)]"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
          <input aria-label="Find a concept" placeholder="Find a concept" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
            className="w-full min-w-0 bg-transparent text-[13px] text-[var(--mind-text)] outline-none placeholder:text-[var(--mind-muted)]" />
        </label>
        <button type="button" onClick={switchTheme} aria-label={theme === "dark" ? "Switch to light (paper) theme" : "Switch to dark theme"} title={theme === "dark" ? "Paper" : "Night"} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">
          {theme === "dark"
            ? <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></svg>
            : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>}
        </button>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close Mind" className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">✕</button>
      </header>
      {node && frame && map && <Sheet node={node} frame={frame} map={map} palette={palette} onClose={() => setSelected(null)} />}
      {showKey && (
        <div role="group" aria-label="What the other marks mean" className="absolute bottom-[116px] left-3 grid w-[min(290px,calc(100%-24px))] grid-cols-[22px_minmax(0,1fr)] items-center gap-2 rounded-2xl border border-[var(--mind-line)] bg-[var(--mind-glass)] p-3 text-[12px] text-[var(--mind-text-2)] backdrop-blur-xl">
          <span className="h-3 w-3 rounded-full border-2" style={{ borderColor: palette.resolved }} /><span>Gold ring: wrong belief fixed</span>
          <span className="h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: palette.learning }} /><span>Dashed: early read, few answers</span>
          <span className="h-3 w-3 rounded-full" style={{ background: palette.unseen }} /><span>Grey: not practised yet</span>
          <span className="h-0.5" style={{ background: palette.synapse }} /><span>Violet line: one idea built on another</span>
          <span className="h-0.5" style={{ background: palette.misfire }} /><span>Red line: two ideas mixed up</span>
        </div>
      )}
      {map && frame && (
        <div role="group" aria-label="Filter by state" className="absolute inset-x-3 bottom-[68px] flex flex-wrap items-center gap-1.5">
          {CHIPS.map((c) => (
            <button key={c.state} type="button" aria-pressed={filter === c.state} title={`${STATE_MEANINGS[c.state]} Press to show only these.`}
              onClick={() => setFilter(filter === c.state ? null : c.state)}
              className={`flex min-h-10 items-center gap-1.5 rounded-full border bg-[var(--mind-glass)] px-3 text-[12px] backdrop-blur-xl ${filter === c.state ? "border-[var(--mind-text)]" : "border-[var(--mind-line)]"}`}>
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={c.state === "misconception"
                ? { background: stateColor(c.state, palette), outline: `2px solid ${palette.misconception}` } : { background: stateColor(c.state, palette) }} />
              {c.name} <span className="text-[var(--mind-muted)]">{counts[c.state] ?? 0}</span>
            </button>
          ))}
          <button type="button" aria-label="What the other marks mean" aria-pressed={showKey} onClick={() => setShowKey(!showKey)}
            className="grid h-10 w-10 place-items-center rounded-full border border-[var(--mind-line)] bg-[var(--mind-glass)] text-[14px] backdrop-blur-xl">?</button>
        </div>
      )}
      {map && (
        <footer className="absolute inset-x-3 bottom-3 flex h-12 items-center gap-2 rounded-2xl border border-[var(--mind-line)] bg-[var(--mind-glass)] px-2 backdrop-blur-xl">
          {!still && <>
            <button type="button" aria-label="Zoom out" onClick={() => control.current?.zoom(1 / 1.45)} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">−</button>
            <button type="button" aria-label="Zoom in" onClick={() => control.current?.zoom(1.45)} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--mind-line)]">+</button>
            <button type="button" disabled={k < 1} onClick={() => replay(k)} className="h-9 shrink-0 rounded-lg border border-[var(--mind-line)] px-3 text-[13px] disabled:opacity-40">▶ Replay session {k + 1}</button>
          </>}
          <input type="range" min={0} max={last} step={1} value={k} disabled={last < 1} aria-label="Revision"
            onChange={(e) => { cancelAnimationFrame(raf.current); setU(null); setK(Number(e.target.value)); }} className="min-w-0 flex-1 accent-[var(--mind-accent)]" />
          {u == null && shown && shown.changed.length > 0
            ? <button type="button" aria-pressed={showChanged} onClick={() => setShowChanged(!showChanged)}
                className={`h-9 shrink-0 whitespace-nowrap rounded-lg border border-[var(--mind-line)] px-3 text-[12px] ${showChanged ? "bg-[var(--mind-good-bg)] text-[var(--mind-good)]" : "text-[var(--mind-text-2)]"}`}>
                {shown.changed.length} changed {k === last ? "last session" : `in session ${k + 1}`}
              </button>
            : <span className="hidden min-w-[110px] text-right text-[12px] text-[var(--mind-muted)] sm:inline" aria-live="polite">{u != null ? "Replaying…" : shown ? `After session ${k + 1}` : ""}</span>}
        </footer>
      )}
    </div>
  );
}
