"use client";

// Review: checks from earlier sessions that are due now (the warm-up queue). Starting draws the first one on the
// board with no model call; answers count as evidence like any other check.
import { useEffect, useState } from "react";
import { conceptLabel } from "@/components/constellation/map-model";
import PlaceSheet from "@/components/places/PlaceSheet";
import type { TutorTurnState } from "@/hooks/useTutorSession";
import type { Outcome, ProfileHistory, ProfileEvent } from "@/lib/learner-contracts";

const REASONS = {
  misconception: { label: "Misconception", tone: "bg-rose-100 text-rose-800" },
  fading: { label: "Fading", tone: "bg-amber-100 text-amber-800" },
  shaky: { label: "Shaky", tone: "bg-indigo-100 text-indigo-800" },
} as const;
const MARKS: Record<Outcome, { mark: string; label: string; tone: string }> = {
  correct: { mark: "✓", label: "Right", tone: "bg-emerald-100 text-emerald-700" },
  partial: { mark: "~", label: "Partly", tone: "bg-sky-100 text-sky-700" },
  incorrect: { mark: "!", label: "Not quite", tone: "bg-amber-100 text-amber-700" },
  unanswered: { mark: "·", label: "Told the answer", tone: "bg-slate-100 text-slate-500" },
};
const RECENT = 6;

/** The latest answered checks sealed into the profile (what Mind rests on), newest first. */
function useRecentChecks(): ProfileEvent[] | null {
  const [events, setEvents] = useState<ProfileEvent[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/learning/profile/revisions", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then((r) => (r.ok ? r.json() as Promise<ProfileHistory> : { revisions: [], events: [] }))
      .then((body) => setEvents([...body.events].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, RECENT)))
      .catch(() => { if (!controller.signal.aborted) setEvents([]); });
    return () => controller.abort();
  }, []);
  return events;
}

export default function ReviewSheet({ tutor, onClose }: { tutor: TutorTurnState; onClose: () => void }) {
  const { items, started } = tutor.warmup;
  const blocked = tutor.busy || tutor.sealed || Boolean(tutor.question);
  const recent = useRecentChecks();

  return (
    <PlaceSheet title="Review" subtitle="Checks from earlier sessions, due now" width="w-[min(900px,100%)]" onClose={onClose}>
        <div className="grid gap-6 md:grid-cols-[1.25fr_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
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
        </div>
        <div className="flex min-w-0 flex-col gap-1" aria-label="Recent checks">
          <h3 className="text-sm font-bold text-slate-900">Recent checks</h3>
          {recent === null ? <p className="text-xs text-slate-500">Loading…</p>
            : recent.length === 0 ? <p className="text-xs text-slate-500">Answered checks appear here once a session is saved.</p>
            : (
              <ul className="flex flex-col" data-testid="recent-checks">
                {recent.map((event) => {
                  const m = MARKS[event.outcome] ?? MARKS.unanswered;
                  return (
                    <li key={event.id} className="flex items-start gap-2.5 border-b border-slate-900/5 py-2.5">
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${m.tone}`} aria-label={m.label}>{m.mark}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-slate-900">{event.question}</span>
                        <span className="block text-[11px] text-slate-500">
                          {m.label} · {conceptLabel(event.concept, [event.question])} · {new Date(event.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
        </div>
    </PlaceSheet>
  );
}
