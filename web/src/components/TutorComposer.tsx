"use client";

import type { TutorTurnState } from "@/hooks/useTutorSession";

interface Props {
  tutor: TutorTurnState;
  /** Another board action (legacy teach, Practice) is running. */
  blocked?: boolean;
  onStop: () => void;
  variant?: "studio" | "mobile";
}

/** Typed question box: the first slice of the voice/pen-first ask. Keeps the text until a turn starts. */
export default function TutorComposer({ tutor, blocked = false, onStop, variant = "studio" }: Props) {
  const unavailable = tutor.configured === false;
  const disabled = blocked || unavailable || tutor.busy;
  const submit = () => { if (!disabled && tutor.draft.trim()) tutor.ask(tutor.draft); };
  const placeholder = unavailable ? "Tutor not configured on the server"
    : tutor.question ? "Answer the card, or ask something else…" : "Ask about anything on the board…";

  return (
    <div className={variant === "mobile" ? "w-full" : "pointer-events-auto fixed bottom-4 left-1/2 z-40 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2"}
      data-testid="tutor-composer">
      {(tutor.caption || tutor.error) && (
        <p className={`mb-1.5 rounded-xl px-3 py-1.5 text-xs shadow-sm ${tutor.error ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200" : "bg-white/95 text-slate-600 ring-1 ring-slate-200"}`}
          role={tutor.error ? "alert" : "status"}>
          {tutor.error || `Y: ${tutor.caption}`}
        </p>
      )}
      <form className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-[0_14px_45px_rgba(15,23,42,.14)] backdrop-blur-xl"
        onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          aria-label="Ask the tutor"
          value={tutor.draft}
          rows={1}
          maxLength={2000}
          disabled={unavailable}
          placeholder={placeholder}
          onChange={(event) => tutor.setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }}
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl bg-transparent px-2 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
        />
        {tutor.busy ? (
          <button type="button" onClick={onStop} className="min-h-10 shrink-0 rounded-xl bg-rose-500 px-4 text-sm font-semibold text-white">Stop</button>
        ) : (
          <button type="submit" disabled={disabled || !tutor.draft.trim()} className="min-h-10 shrink-0 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40">Ask</button>
        )}
      </form>
    </div>
  );
}
