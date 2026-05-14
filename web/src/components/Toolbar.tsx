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
  // Excalidraw owns the top-center (tool strip) and top-left (menu/library)
  // areas. Place the Y controls in the top-right corner so the native UI is
  // fully usable, and put the status text along the bottom edge.
  return (
    <>
      <div className="pointer-events-none absolute right-4 top-4 z-30 flex flex-col items-end gap-2">
        <div className="pointer-events-auto flex flex-col items-stretch gap-2 rounded-2xl bg-white/95 px-3 py-3 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/95 dark:ring-white/10 min-w-[180px]">
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
              onClick={onInsertSample}
              disabled={busy}
              title="Drop a Newton's-law style question on the canvas"
              className="rounded-lg bg-zinc-100 px-2 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Sample
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="rounded-lg bg-zinc-100 px-2 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              Clear
            </button>
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
