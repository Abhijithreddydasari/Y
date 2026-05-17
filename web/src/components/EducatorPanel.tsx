"use client";

import { useState } from "react";
import type { EducatorNotes } from "@/lib/types";

interface Props {
  notes: EducatorNotes | null;
  busy?: boolean;
}

const DIFFICULTY_TONE: Record<string, string> = {
  introductory: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  intermediate: "bg-amber-100 text-amber-800 ring-amber-300",
  advanced: "bg-rose-100 text-rose-800 ring-rose-300",
};

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="px-3 py-2">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {title}
      </h3>
      <ul className="space-y-1.5 text-[12px] leading-snug text-zinc-700 dark:text-zinc-200">
        {items.map((s, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-hidden="true" className="select-none text-zinc-400">-</span>
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Right-edge collapsible panel that surfaces the second Gemma call's
 * educator notes (misconceptions, follow-ups, prerequisites, difficulty).
 * Empty when teacher mode is off or the call is in flight.
 */
export default function EducatorPanel({ notes, busy }: Props) {
  const [open, setOpen] = useState(true);
  const hasContent =
    notes &&
    (notes.misconceptions?.length ||
      notes.follow_ups?.length ||
      notes.prereqs?.length ||
      notes.difficulty);

  return (
    <div className="pointer-events-none absolute bottom-12 right-4 z-30 flex max-h-[60vh] flex-col items-end gap-2">
      <div className="pointer-events-auto w-[260px] overflow-y-auto rounded-2xl bg-white/95 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-t-2xl px-3 py-2 text-left text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="flex items-center gap-2">
            For the educator
            {busy && (
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-label="loading" />
            )}
          </span>
          <span aria-hidden className="text-xs text-zinc-500">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            {!hasContent && !busy && (
              <p className="px-3 py-3 text-[12px] italic text-zinc-500 dark:text-zinc-400">
                Turn on Teacher Mode and run a lesson to see what an instructional coach would flag.
              </p>
            )}
            {!hasContent && busy && (
              <p className="px-3 py-3 text-[12px] italic text-zinc-500 dark:text-zinc-400">
                Coach is reviewing the lesson...
              </p>
            )}
            {hasContent && notes && (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {notes.difficulty && (
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Difficulty
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
                        DIFFICULTY_TONE[notes.difficulty.toLowerCase()] ??
                        "bg-zinc-100 text-zinc-700 ring-zinc-300"
                      }`}
                    >
                      {notes.difficulty}
                    </span>
                  </div>
                )}
                <Section title="Common misconceptions" items={notes.misconceptions ?? []} />
                <Section title="Suggested follow-ups" items={notes.follow_ups ?? []} />
                <Section title="Prerequisites" items={notes.prereqs ?? []} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
