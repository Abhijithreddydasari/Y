"use client";

// Review: checks from earlier sessions that are due now (the warm-up queue). Starting draws the first one on the
// board with no model call; answers count as evidence like any other check.
import { useEffect } from "react";
import { conceptLabel } from "@/components/constellation/map-model";
import type { TutorTurnState } from "@/hooks/useTutorSession";

const REASONS = {
  misconception: { label: "Misconception", tone: "bg-rose-100 text-rose-800" },
  fading: { label: "Fading", tone: "bg-amber-100 text-amber-800" },
  shaky: { label: "Shaky", tone: "bg-indigo-100 text-indigo-800" },
} as const;

export default function ReviewSheet({ tutor, onClose }: { tutor: TutorTurnState; onClose: () => void }) {
  const { items, started } = tutor.warmup;
  const blocked = tutor.busy || tutor.sealed || Boolean(tutor.question);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-[90] grid place-items-center bg-slate-950/25 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Review" onClick={(event) => event.stopPropagation()}
        className="y-glass-strong flex max-h-[84dvh] w-[min(560px,100%)] flex-col gap-4 rounded-[28px] p-5">
        <header className="flex items-center gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-950">Review</h2>
            <p className="text-xs text-slate-500">Checks from earlier sessions, due now</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close review" className="ml-auto grid h-10 w-10 place-items-center rounded-full bg-slate-900/5 text-lg">×</button>
        </header>
        {items.length === 0 ? (
          <p className="rounded-2xl bg-white p-4 text-sm text-slate-600">
            Nothing is due. Checks you answer become reviews once you end a session, and come back as they fade.
          </p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto" data-testid="review-items">
            {items.map((item) => {
              const reason = REASONS[item.reason];
              return (
                <li key={item.concept} className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`rounded-full px-2 py-0.5 font-bold ${reason.tone}`}>{reason.label}</span>
                    <span className="font-semibold text-slate-700">{conceptLabel(item.concept, [item.q])}</span>
                  </div>
                  <p className="text-sm font-medium leading-5 text-slate-900">{item.q}</p>
                  <div className="grid grid-cols-[64px_1fr_36px] items-center gap-2 text-[11px] text-slate-500">
                    <span>Memory</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <span className={`block h-full rounded-full ${item.retention < 0.5 ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${Math.round(item.retention * 100)}%` }} />
                    </span>
                    <span className="text-right tabular-nums">{Math.round(item.retention * 100)}%</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {items.length > 0 && (
          <div className="flex items-center gap-2">
            <button type="button" disabled={blocked} onClick={() => { tutor.warmup.start(); onClose(); }}
              className="min-h-12 rounded-2xl bg-slate-900 px-5 text-sm font-bold text-white disabled:opacity-40">
              {started ? "Next check" : `Start warm-up · ${items.length} check${items.length === 1 ? "" : "s"}`}
            </button>
            <span className="text-xs text-slate-500">{tutor.question ? "Answer the open card first." : "Drawn on your board at once, no wait."}</span>
          </div>
        )}
      </section>
    </div>
  );
}
