"use client";

import type { LearnerSnapshot } from "@/lib/types";

interface Props {
  open: boolean;
  snapshot: LearnerSnapshot | null;
  onClose: () => void;
  onReset: () => void;
}

function percent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export default function MobileLearnerSheet({ open, snapshot, onClose, onReset }: Props) {
  if (!open) return null;
  const state = snapshot?.learner_state;
  const beliefs = [...(state?.concept_beliefs ?? [])]
    .sort((a, b) => b.evidence_count - a.evidence_count)
    .slice(0, 8);

  return (
    <div className="pointer-events-auto fixed inset-0 z-[80] flex items-end bg-slate-950/35" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Learning profile"
        onClick={(event) => event.stopPropagation()}
        className="mobile-sheet max-h-[78dvh] w-full overflow-y-auto rounded-t-[28px] bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[.16em] text-indigo-600">Evidence-aware</p>
            <h2 className="text-xl font-bold text-slate-950">Your learning profile</h2>
            <p className="mt-1 text-sm text-slate-500">Confidence changes only when your work provides evidence.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close learning profile" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-slate-100 text-xl text-slate-600">×</button>
        </div>

        {beliefs.length ? (
          <div className="mt-5 space-y-3">
            {beliefs.map((belief) => (
              <article key={belief.name} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-slate-900">{belief.display_name ?? belief.name}</h3>
                    <p className="mt-0.5 text-[11px] text-slate-500">{belief.evidence_count} evidence event{belief.evidence_count === 1 ? "" : "s"}</p>
                  </div>
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-bold text-indigo-700">{percent(belief.mastery_mean)}</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-gradient-to-r from-amber-400 via-indigo-500 to-emerald-500" style={{ width: percent(belief.mastery_mean) }} />
                </div>
                <div className="mt-2 flex justify-between text-[10px] text-slate-500">
                  <span>range {percent(belief.credible_low)}–{percent(belief.credible_high)}</span>
                  <span className={belief.mastery_delta > 0 ? "text-emerald-600" : belief.mastery_delta < 0 ? "text-amber-700" : ""}>
                    {belief.mastery_delta > 0 ? "+" : ""}{Math.round(belief.mastery_delta * 100)} recent
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-dashed border-indigo-200 bg-indigo-50/60 px-4 py-8 text-center">
            <p className="font-semibold text-indigo-950">No evidence yet</p>
            <p className="mt-1 text-sm leading-5 text-indigo-700">Complete a lesson and answer its checkpoint to build this profile.</p>
          </div>
        )}

        {state?.profile_text && <p className="mt-4 rounded-2xl bg-emerald-50 p-3 text-sm leading-5 text-emerald-900">{state.profile_text}</p>}
        <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
          <span>{state?.observations ?? 0} observations</span>
          <span>Bayesian evidence model</span>
        </div>
        <button type="button" onClick={onReset} className="mt-4 min-h-11 w-full rounded-xl border border-rose-200 text-sm font-medium text-rose-700">Reset learning profile</button>
      </section>
    </div>
  );
}
