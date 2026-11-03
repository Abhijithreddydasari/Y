"use client";

import { useEffect, useState } from "react";
import { boardSession, openBoardSession } from "@/lib/board-api";
import { fetchCanvases, tutorErrorMessage, type Canvas } from "@/lib/tutor-turn";

/** Saved sessions (Canvases) to resume. Opening one makes it the board session and reloads. */
export default function CanvasList({ variant = "studio" }: { variant?: "studio" | "mobile" }) {
  const [open, setOpen] = useState(false);
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([fetchCanvases(), boardSession()]).then(([listed, id]) => {
      if (!cancelled) { setCanvases(listed); setCurrent(id); }
    }).catch((failure) => { if (!cancelled) setError(tutorErrorMessage(failure)); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const resume = (id: string) => {
    if (id === current) { setOpen(false); return; }
    openBoardSession(id);
    window.location.reload();
  };

  return (
    <>
      <button type="button" onClick={() => { setError(""); setCanvases(null); setOpen(true); }} aria-label="Canvases: saved sessions"
        className={variant === "mobile"
          ? "min-h-12 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700"
          : "pointer-events-auto fixed left-3 top-[108px] z-40 flex h-9 items-center gap-1.5 y-glass rounded-xl px-2.5 text-[12px] font-semibold text-slate-700 hover:bg-white"}>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="9" height="9" rx="1.5" /><path d="M5 1.5h8.5a1 1 0 0 1 1 1V11" />
        </svg>
        Canvases
      </button>
      {open && (
        <div className="pointer-events-auto fixed inset-0 z-[90] grid place-items-center bg-slate-950/35 p-4" onClick={() => setOpen(false)}>
          <section role="dialog" aria-modal="true" aria-label="Canvases" onClick={(event) => event.stopPropagation()}
            className="max-h-[80dvh] w-[min(440px,100%)] overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-950">Canvases</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-lg">×</button>
            </div>
            {error ? <p role="alert" className="text-sm text-rose-700">{error}</p>
              : canvases === null ? <p className="text-sm text-slate-500">Loading…</p>
              : canvases.length === 0 ? <p className="text-sm text-slate-500">No saved canvases yet.</p>
              : (
                <ul className="flex flex-col gap-1.5">
                  {canvases.map((canvas) => (
                    <li key={canvas.session_id}>
                      <button type="button" onClick={() => resume(canvas.session_id)} aria-current={canvas.session_id === current}
                        className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm ${canvas.session_id === current ? "border-violet-400 bg-violet-50" : "border-slate-200 hover:border-violet-300"}`}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-slate-900">{canvas.title}</span>
                          <span className="block text-[11px] text-slate-500">
                            {new Date(canvas.created_at * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                            {" · "}{canvas.turns} turn{canvas.turns === 1 ? "" : "s"}
                          </span>
                        </span>
                        {canvas.session_id === current ? <span className="text-[11px] font-semibold text-violet-700">Open</span>
                          : canvas.sealed ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Sealed</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
      )}
    </>
  );
}
