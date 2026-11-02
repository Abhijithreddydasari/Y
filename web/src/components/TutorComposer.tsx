"use client";

import MicButton from "@/components/MicButton";
import TutorPicker from "@/components/TutorPicker";
import type { TutorTurnState } from "@/hooks/useTutorSession";
import { useVoiceInput } from "@/hooks/useVoiceInput";

interface Props {
  tutor: TutorTurnState;
  /** Another board action (legacy teach, Practice) is running. */
  blocked?: boolean;
  onStop: () => void;
  variant?: "studio" | "mobile";
}

/** Question box: type or push-to-talk. A transcript asks exactly like typed text and stays editable if the turn fails. */
export default function TutorComposer({ tutor, blocked = false, onStop, variant = "studio" }: Props) {
  const voice = useVoiceInput(tutor.ask, tutor.hush);
  const unavailable = tutor.configured === false;
  const disabled = blocked || unavailable || tutor.busy;
  const notice = tutor.error || voice.error;
  const submit = () => { if (!disabled && tutor.draft.trim()) { voice.clearError(); tutor.ask(tutor.draft); } };
  const placeholder = unavailable ? "Tutor not configured on the server"
    : tutor.question ? "Answer the card, or ask something else…" : "Ask about anything on the board…";

  return (
    <div className={variant === "mobile" ? "w-full" : "pointer-events-auto fixed bottom-4 left-1/2 z-40 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2"}
      data-testid="tutor-composer">
      {(tutor.caption || notice) && (
        <p className={`mb-1.5 rounded-xl px-3 py-1.5 text-xs shadow-sm ${notice ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200" : "bg-white/95 text-slate-600 ring-1 ring-slate-200"}`}
          role={notice ? "alert" : "status"}>
          {notice || `Y: ${tutor.caption}`}
        </p>
      )}
      <form className="relative flex items-end gap-2 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-[0_14px_45px_rgba(15,23,42,.14)] backdrop-blur-xl"
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
        <TutorPicker options={tutor.picker.options} prefs={tutor.picker.prefs} trace={tutor.picker.trace}
          onModel={tutor.picker.setModel} onVoice={tutor.picker.setVoice} compact={variant === "mobile"} />
        <MicButton voice={voice} disabled={disabled} label="Hold to ask by voice" />
        {tutor.busy ? (
          <button type="button" onClick={onStop} className="min-h-10 shrink-0 rounded-xl bg-rose-500 px-4 text-sm font-semibold text-white">Stop</button>
        ) : (
          <>
            {tutor.narrating && (
              <button type="button" onClick={onStop} className="min-h-10 shrink-0 rounded-xl border border-rose-300 px-3 text-sm font-semibold text-rose-600">Stop</button>
            )}
            <button type="submit" disabled={disabled || !tutor.draft.trim()} className="min-h-10 shrink-0 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40">Ask</button>
          </>
        )}
      </form>
    </div>
  );
}
