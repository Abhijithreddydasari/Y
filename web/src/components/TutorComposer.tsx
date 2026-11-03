"use client";

import MicButton from "@/components/MicButton";
import TraceButton from "@/components/trace/TraceButton";
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
  const unavailable = tutor.configured === false || tutor.sealed;
  const disabled = blocked || unavailable || tutor.busy;
  const notice = tutor.error || voice.error;
  const submit = () => { if (!disabled && tutor.draft.trim()) { voice.clearError(); tutor.ask(tutor.draft); } };
  const placeholder = tutor.sealed ? "This canvas is sealed. Start a new session to ask." : unavailable ? "Tutor not configured on the server"
    : tutor.question ? "Answer the card, or ask something else…" : "Ask about anything on the board…";

  return (
    <div className={variant === "mobile" ? "w-full" : "pointer-events-auto fixed bottom-4 left-1/2 z-40 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2"}
      data-testid="tutor-composer">
      {(tutor.caption || notice) && (
        <p className={`mb-1.5 rounded-xl px-3 py-1.5 text-xs shadow-sm ${notice ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200" : "y-glass text-slate-600"}`}
          role={notice ? "alert" : "status"}>
          {notice || `Y: ${tutor.caption}`}
        </p>
      )}
      {tutor.exit.offered && !tutor.busy && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-xl bg-violet-50 px-3 py-1.5 text-xs text-violet-900 ring-1 ring-violet-200"
          role="group" aria-label="Exit ticket" data-testid="exit-offer">
          <span className="mr-auto font-medium">One quick check before you go?</span>
          <button type="button" onClick={tutor.exit.take} className="min-h-8 rounded-lg bg-violet-600 px-3 font-semibold text-white">Take it</button>
          <button type="button" onClick={tutor.exit.skip} disabled={tutor.ending} className="min-h-8 rounded-lg px-2 font-semibold text-violet-700 disabled:opacity-40">Just end</button>
        </div>
      )}
      {tutor.warmup.visible && !tutor.question && !tutor.busy && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-3 py-1.5 text-xs text-amber-900 ring-1 ring-amber-200"
          role="group" aria-label="Warm-up" data-testid="warmup"
          title={tutor.warmup.items.map((item) => item.q).join(" · ")}>
          <span className="mr-auto font-medium">
            {tutor.warmup.started ? `Next warm-up · ${tutor.warmup.items.length} left` : `Warm-up · ${tutor.warmup.items.length} due from last time`}
          </span>
          <button type="button" onClick={tutor.warmup.start} className="min-h-8 rounded-lg bg-amber-500 px-3 font-semibold text-white">
            {tutor.warmup.started ? "Next" : "Start"}
          </button>
          <button type="button" onClick={tutor.warmup.skip} className="min-h-8 rounded-lg px-2 font-semibold text-amber-800">
            {tutor.warmup.started ? "Done" : "Skip"}
          </button>
        </div>
      )}
      {tutor.sealed && (
        <div className="mb-1.5 flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-1.5 text-xs text-slate-700 ring-1 ring-slate-200" data-testid="sealed">
          <span className="mr-auto">This canvas is sealed in your profile. You can look around.</span>
          <button type="button" onClick={tutor.newSession} className="min-h-8 rounded-lg bg-slate-900 px-3 font-semibold text-white">New session</button>
        </div>
      )}
      <div className="mb-1.5 flex items-center justify-end gap-2 text-xs">
        {tutor.memory.on && tutor.memory.turn?.items.length ? (
          <span className="truncate rounded-full bg-indigo-50 px-2.5 py-1 text-indigo-700 ring-1 ring-indigo-200" data-testid="memory-used"
            title={tutor.memory.turn.items.map((item) => `${item.id}: ${item.text}`).join("\n")}>
            Using {tutor.memory.turn.items.length} item{tutor.memory.turn.items.length === 1 ? "" : "s"} from earlier sessions
          </span>
        ) : null}
        <label className="flex cursor-pointer items-center gap-1.5 y-glass rounded-full px-2.5 py-1 text-slate-600">
          <input type="checkbox" role="switch" aria-label="Memory" checked={tutor.memory.on} disabled={tutor.busy}
            onChange={(event) => tutor.memory.set(event.target.checked)} className="accent-indigo-600" />
          Memory {tutor.memory.on ? "on" : "off"}
        </label>
        <button type="button" onClick={tutor.endSession} disabled={tutor.busy || tutor.ending || unavailable}
          className="y-glass rounded-full px-2.5 py-1 font-semibold text-slate-700 disabled:opacity-40">
          {tutor.ending ? "Saving…" : "End session"}
        </button>
        <TraceButton timing={tutor.timing} />
      </div>
      <form className="relative flex items-end gap-2 y-glass rounded-2xl p-2"
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
