"use client";

import type { Checkpoint, LearningEvidence } from "@/lib/types";

export default function CheckpointCard({
  checkpoint,
  evidence,
  variant = "studio",
}: {
  checkpoint: Checkpoint | null;
  evidence: LearningEvidence | null;
  variant?: "studio" | "mobile";
}) {
  if (!checkpoint && !evidence) return null;
  const score = evidence
    ? Math.round((evidence.outcome.correct + 0.5 * evidence.outcome.partial) * 100)
    : null;
  return (
    <div className={variant === "mobile"
      ? "pointer-events-auto fixed bottom-[calc(6.75rem+env(safe-area-inset-bottom))] left-3 right-3 z-40 max-h-[28dvh] overflow-y-auto rounded-2xl border border-violet-100 bg-white/96 px-4 py-3 shadow-[0_16px_50px_rgba(76,29,149,.16)] backdrop-blur-xl"
      : "pointer-events-auto absolute bottom-12 left-1/2 z-30 w-[min(540px,70vw)] -translate-x-1/2 rounded-xl bg-white/95 px-4 py-3 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10"}
    >
      {evidence && (
        <div className="mb-2 flex items-center justify-between border-b border-zinc-100 pb-2 text-xs dark:border-zinc-800">
          <span className="font-medium text-zinc-800 dark:text-zinc-100">Last assessment: {score}% evidence-weighted</span>
          <span className={evidence.adaptation?.adapted ? "text-emerald-600" : "text-zinc-500"}>
            {evidence.adaptation?.adapted ? `Learner adapted (${evidence.adaptation.steps ?? 0} steps)` : "History only"}
          </span>
        </div>
      )}
      {checkpoint && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-600">Checkpoint · {checkpoint.difficulty}</span>
            <span className="text-[9px] text-zinc-400">Answer directly on the canvas</span>
          </div>
          <p className="mt-1 text-sm font-medium leading-snug text-zinc-900 dark:text-zinc-100">{checkpoint.question}</p>
          <div className="mt-1 text-[10px] text-zinc-500">{checkpoint.concepts.join(" · ")}</div>
        </div>
      )}
    </div>
  );
}
