"use client";

import { type ChangeEvent } from "react";

export type ModelChoice = "edge" | "edge-ft" | "cloud";

export const MODEL_CHOICES: { id: ModelChoice; label: string; subtitle: string }[] = [
  { id: "edge", label: "Edge (E4B)", subtitle: "gemma4:e4b on Ollama" },
  { id: "edge-ft", label: "Edge fine-tuned (E2B+LoRA)", subtitle: "y-gemma4 ControlSketch LoRA" },
  { id: "cloud", label: "Cloud (Gemma 4 31B)", subtitle: "Google AI Studio" },
];

export type SampleSubject = "math" | "physics" | "chem" | "bio" | "cs";

export const SAMPLE_SUBJECTS: { id: SampleSubject; label: string }[] = [
  { id: "math", label: "Math" },
  { id: "physics", label: "Physics" },
  { id: "chem", label: "Chem" },
  { id: "bio", label: "Bio" },
  { id: "cs", label: "CS" },
];

interface Props {
  busy: boolean;
  status: string;
  ttsEnabled: boolean;
  teacherMode: boolean;
  modelChoice: ModelChoice;
  modelReady?: Partial<Record<ModelChoice, boolean>>;
  canReplay: boolean;
  onSolve: () => void;
  onClear: () => void;
  onInsertSample: (subject: SampleSubject) => void;
  onReplay: () => void;
  onStop: () => void;
  onToggleTts: () => void;
  onToggleTeacherMode: () => void;
  onModelChange: (model: ModelChoice) => void;
}

export default function Toolbar({
  busy,
  status,
  ttsEnabled,
  teacherMode,
  modelChoice,
  modelReady,
  canReplay,
  onSolve,
  onClear,
  onInsertSample,
  onReplay,
  onStop,
  onToggleTts,
  onToggleTeacherMode,
  onModelChange,
}: Props) {
  // Excalidraw owns the top-center (tool strip) and top-left (menu/library)
  // areas. Place the Y controls in the top-right corner so the native UI is
  // fully usable, and put the status text along the bottom edge.
  const handleModelSelect = (e: ChangeEvent<HTMLSelectElement>) => {
    onModelChange(e.target.value as ModelChoice);
  };

  return (
    <>
      <div className="pointer-events-none absolute right-4 top-4 z-30 flex flex-col items-end gap-2">
        <div className="pointer-events-auto flex flex-col items-stretch gap-2 rounded-2xl bg-white/95 px-3 py-3 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10 min-w-[220px]">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Y - Tutor
            </span>
            <label className="flex select-none items-center gap-1.5 text-[11px] text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={ttsEnabled}
                onChange={onToggleTts}
                className="h-3.5 w-3.5 accent-emerald-600"
              />
              narrate
            </label>
          </div>
          <label className="-mt-0.5 flex select-none items-center gap-1.5 px-1 text-[11px] text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={teacherMode}
              onChange={onToggleTeacherMode}
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            Teacher Mode
            <span className="text-zinc-400">(adds educator panel)</span>
          </label>
          <label className="flex flex-col gap-0.5 px-1 text-[11px] text-zinc-700 dark:text-zinc-300">
            <span className="text-zinc-500">Model</span>
            <select
              value={modelChoice}
              onChange={handleModelSelect}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-800 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            >
              {MODEL_CHOICES.map((m) => {
                const ready = modelReady?.[m.id];
                const labelSuffix =
                  ready === false ? " · not configured" : "";
                return (
                  <option
                    key={m.id}
                    value={m.id}
                    title={m.subtitle + (ready === false ? " (set GOOGLE_API_KEY or pull the GGUF)" : "")}
                  >
                    {m.label}
                    {labelSuffix}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            onClick={onSolve}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {busy ? "Thinking..." : "Solve  (mark ? on canvas)"}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onReplay}
              disabled={busy || !canReplay}
              title="Replay last lesson without re-asking"
              className="rounded-lg bg-indigo-600 px-2 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              Replay
            </button>
            <button
              type="button"
              onClick={onStop}
              disabled={!busy}
              className="rounded-lg bg-rose-600 px-2 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="col-span-2 rounded-lg bg-zinc-100 px-2 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Clear board
            </button>
          </div>
          <div className="flex flex-col gap-1 pt-1">
            <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Sample question
            </span>
            <div className="grid grid-cols-5 gap-1">
              {SAMPLE_SUBJECTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onInsertSample(s.id)}
                  disabled={busy}
                  className="rounded-md bg-zinc-100 px-1 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center">
        <div className="pointer-events-auto max-w-[80vw] truncate rounded-md bg-black/75 px-3 py-1 text-xs text-white shadow">
          {status}
        </div>
      </div>
    </>
  );
}
