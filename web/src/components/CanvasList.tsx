"use client";

import { useEffect, useMemo, useState } from "react";
import PlaceSheet from "@/components/places/PlaceSheet";
import { boardSession, openBoardSession } from "@/lib/board-api";
import { BOARD_QUESTION, fetchCanvases, tutorErrorMessage, type Canvas } from "@/lib/tutor-turn";

type Filter = "all" | "open" | "sealed";
/** A canvas opened with an empty Ask is titled by what it was, not by the prompt sent for it. */
const titleOf = (canvas: Canvas) => (canvas.title === BOARD_QUESTION.slice(0, 80) ? "Question on the board" : canvas.title);

/** Saved sessions (Canvases) to resume. Opening one makes it the board session and reloads. */
export function CanvasDialog({ onClose, onNew }: { onClose: () => void; onNew?: () => void }) {
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

  const shown = useMemo(() => (canvases ?? []).filter((c) =>
    (filter === "all" || (filter === "sealed") === c.sealed) && titleOf(c).toLowerCase().includes(query.trim().toLowerCase())), [canvases, filter, query]);

  const resume = (id: string) => {
    if (id === current) { onClose(); return; }
    openBoardSession(id);
    window.location.reload();
  };

  return (
    <PlaceSheet title="Canvases" subtitle={canvases ? `${canvases.length} saved · newest first` : "Saved boards"} width="w-[min(920px,100%)]" onClose={onClose}
      actions={<>
        <input aria-label="Search canvases" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by question"
          className="h-10 w-[min(240px,100%)] rounded-full bg-slate-900/5 px-4 text-sm outline-none focus:ring-2 focus:ring-violet-300" />
        <div role="group" aria-label="Show" className="flex rounded-xl bg-slate-900/5 p-0.5 text-xs font-semibold">
          {(["all", "open", "sealed"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
              className={`rounded-[10px] px-3 py-2 capitalize ${filter === f ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>{f}</button>
          ))}
        </div>
      </>}>
          {error ? <p role="alert" className="text-sm text-rose-700">{error}</p>
            : canvases === null ? <p className="text-sm text-slate-500">Loading…</p>
            : shown.length === 0 && !onNew ? <p className="text-sm text-slate-500">{canvases.length ? "No canvases match." : "No saved canvases yet."}</p>
            : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
                {onNew && (
                  <li>
                    <button type="button" onClick={() => { onClose(); onNew(); }}
                      className="flex h-full min-h-52 w-full flex-col items-center justify-center gap-2 rounded-[20px] border-[1.5px] border-dashed border-slate-300 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-white/60">
                      <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-900 text-2xl font-normal text-white">+</span>
                      New canvas
                      <span className="text-xs font-normal text-slate-500">Starts with a warm-up when checks are due</span>
                    </button>
                  </li>
                )}
                {shown.map((canvas) => {
                  const here = canvas.session_id === current;
                  return (
                    <li key={canvas.session_id}>
                      <button type="button" onClick={() => resume(canvas.session_id)} aria-current={here}
                        className={`flex h-full w-full flex-col overflow-hidden rounded-[20px] border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${here ? "border-violet-400 ring-2 ring-violet-200" : "border-slate-200"}`}>
                        {/* A board-like header: the opening question in the board's hand, on its dotted grid. */}
                        <span className="relative block h-28 overflow-hidden border-b border-slate-100 bg-[#fbfbf8] bg-[radial-gradient(rgba(15,23,42,.08)_1px,transparent_1.2px)] bg-[length:14px_14px] px-4 pt-3">
                          {/* line-clamp sets its own display: adding `block` here turns the clamp off. */}
                          <span title={titleOf(canvas)} data-testid="canvas-title" className="line-clamp-3 pr-14 font-[Excalifont,Virgil,'Segoe_Print',cursive] text-[17px] leading-6 text-slate-800">{titleOf(canvas)}</span>
                          <span className={`absolute right-3 top-3 rounded-full px-2 py-0.5 text-[11px] font-bold ${here ? "bg-violet-100 text-violet-800" : canvas.sealed ? "bg-indigo-50 text-indigo-700" : "bg-emerald-50 text-emerald-700"}`}>
                            {here ? "This board" : canvas.sealed ? "Sealed" : "Open"}
                          </span>
                        </span>
                        <span className="flex flex-col gap-1 px-4 py-3">
                          <span className="text-xs text-slate-500">
                            {new Date(canvas.created_at * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                            {" · "}{canvas.turns} turn{canvas.turns === 1 ? "" : "s"}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
    </PlaceSheet>
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
