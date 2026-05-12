"use client";

interface Props {
  busy: boolean;
  status: string;
  ttsEnabled: boolean;
  canReplay: boolean;
  onSolve: () => void;
  onClear: () => void;
  onInsertSample: () => void;
  onReplay: () => void;
  onStop: () => void;
  onToggleTts: () => void;
}

export default function Toolbar({
  busy,
  status,
  ttsEnabled,
  canReplay,
  onSolve,
  onClear,
  onInsertSample,
  onReplay,
  onStop,
  onToggleTts,
}: Props) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-2 p-4">
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-full bg-white/95 px-3 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10">
        <span className="ml-1 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Y - Whiteboard Tutor
        </span>
        <span className="mx-2 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
        <button
          type="button"
          onClick={onSolve}
          disabled={busy}
          className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {busy ? "Thinking..." : "Solve (?)"}
        </button>
        <button
          type="button"
          onClick={onReplay}
          disabled={busy || !canReplay}
          title="Replay the most recent lesson without re-asking the model"
          className="rounded-full bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          Replay
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={!busy}
          className="rounded-full bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          Stop
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onInsertSample}
          disabled={busy}
          title="Insert a Newton's-law style question to demo without writing"
          className="rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          Sample
        </button>
        <span className="mx-2 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
        <label className="flex select-none items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={ttsEnabled}
            onChange={onToggleTts}
            className="h-3.5 w-3.5 accent-emerald-600"
          />
          narrate
        </label>
      </div>
      <div className="pointer-events-auto rounded-md bg-black/70 px-3 py-1 text-xs text-white shadow">
        {status}
      </div>
    </div>
  );
}
