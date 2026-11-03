"use client";

import { useEffect, useMemo, useState } from "react";
import { boardSession, openBoardSession } from "@/lib/board-api";
import { fetchCanvases, tutorErrorMessage, type Canvas } from "@/lib/tutor-turn";

type Filter = "all" | "open" | "sealed";

/** Saved sessions (Canvases) to resume. Opening one makes it the board session and reloads. */
export function CanvasDialog({ onClose }: { onClose: () => void }) {
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchCanvases(), boardSession()]).then(([listed, id]) => {
      if (!cancelled) { setCanvases(listed); setCurrent(id); }
    }).catch((failure) => { if (!cancelled) setError(tutorErrorMessage(failure)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const shown = useMemo(() => (canvases ?? []).filter((c) =>
    (filter === "all" || (filter === "sealed") === c.sealed) && c.title.toLowerCase().includes(query.trim().toLowerCase())), [canvases, filter, query]);

  const resume = (id: string) => {
    if (id === current) { onClose(); return; }
    openBoardSession(id);
    window.location.reload();
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-[90] grid place-items-center bg-slate-950/25 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Canvases" onClick={(event) => event.stopPropagation()}
        className="y-glass-strong flex max-h-[84dvh] w-[min(920px,100%)] flex-col gap-4 rounded-[28px] p-5">
        <header className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold text-slate-950">Canvases</h2>
          {canvases && <span className="text-xs text-slate-500">{canvases.length} saved · newest first</span>}
          <input aria-label="Search canvases" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by question"
            className="ml-auto h-10 w-[min(240px,100%)] rounded-full bg-slate-900/5 px-4 text-sm outline-none focus:ring-2 focus:ring-violet-300" />
          <div role="group" aria-label="Show" className="flex rounded-xl bg-slate-900/5 p-0.5 text-xs font-semibold">
            {(["all", "open", "sealed"] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`rounded-[10px] px-3 py-2 capitalize ${filter === f ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>{f}</button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full bg-slate-900/5 text-lg">×</button>
        </header>
        <div className="min-h-0 overflow-y-auto">
          {error ? <p role="alert" className="text-sm text-rose-700">{error}</p>
            : canvases === null ? <p className="text-sm text-slate-500">Loading…</p>
            : shown.length === 0 ? <p className="text-sm text-slate-500">{canvases.length ? "No canvases match." : "No saved canvases yet."}</p>
            : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                {shown.map((canvas) => {
                  const here = canvas.session_id === current;
                  return (
                    <li key={canvas.session_id}>
                      <button type="button" onClick={() => resume(canvas.session_id)} aria-current={here}
                        className={`flex h-full w-full flex-col gap-1.5 rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${here ? "border-violet-400 ring-2 ring-violet-200" : "border-slate-200"}`}>
                        <span className={`self-start rounded-full px-2 py-0.5 text-[11px] font-bold ${here ? "bg-violet-100 text-violet-800" : canvas.sealed ? "bg-indigo-50 text-indigo-700" : "bg-emerald-50 text-emerald-700"}`}>
                          {here ? "This board" : canvas.sealed ? "Sealed" : "Open"}
                        </span>
                        <span className="line-clamp-2 text-sm font-semibold text-slate-900">{canvas.title}</span>
                        <span className="mt-auto text-[11px] text-slate-500">
                          {new Date(canvas.created_at * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                          {" · "}{canvas.turns} turn{canvas.turns === 1 ? "" : "s"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
      </section>
    </div>
  );
}

/** A button that opens the Canvases dialog (Mobile's More sheet). */
export default function CanvasList({ className = "min-h-12 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Canvases: saved sessions" className={className}>Canvases</button>
      {open && <CanvasDialog onClose={() => setOpen(false)} />}
    </>
  );
}
