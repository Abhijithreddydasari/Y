"use client";

import { useState } from "react";
import CanvasList from "@/components/CanvasList";
import ChatPanel from "@/components/ChatPanel";
import CheckpointCard from "@/components/CheckpointCard";
import { MODEL_CHOICES, SAMPLE_SUBJECTS, type ModelChoice } from "@/components/Toolbar";
import MobileLearnerSheet from "@/components/mobile/MobileLearnerSheet";
import PlacesMenu from "@/components/places/PlacesMenu";
import TutorComposer from "@/components/TutorComposer";
import TutorQuestionCard from "@/components/TutorQuestionCard";
import type { useInterfaceMode } from "@/hooks/useInterfaceMode";
import type { TutorSession } from "@/hooks/useTutorSession";
import { useClassicTools } from "@/lib/classic";

interface Props {
  session: TutorSession;
  interfaceMode: ReturnType<typeof useInterfaceMode>;
}

export default function MobileShell({ session, interfaceMode }: Props) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // The earlier demo surfaces (Teach me, samples, legacy chat) appear only with Classic tools on.
  const classic = useClassicTools();
  const observations = session.learnerSnapshot?.learner_state.observations ?? 0;
  const eventMode = process.env.NEXT_PUBLIC_DEMO_MODE === "event";
  const primaryLabel = session.busy ? "Stop" : session.checkpoint ? "Check my answer" : "Teach me";
  const primaryAction = session.busy ? session.stop : session.checkpoint ? session.assess : session.solve;

  return (
    <div className="pointer-events-none absolute inset-0 z-40" data-interface="mobile">
      <header className="pointer-events-auto fixed inset-x-0 top-0 z-50 y-glass border-x-0 border-t-0 px-3 pb-2 pt-[calc(.55rem+env(safe-area-inset-top))]">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-400 text-lg font-black text-slate-950">Y</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-950">Whiteboard tutor</p>
            <p className="truncate text-[11px] text-slate-500" aria-live="polite">{session.status}</p>
          </div>
          <button type="button" onClick={() => setMoreOpen(true)} aria-label="More controls" className="min-h-11 shrink-0 rounded-xl bg-slate-100 px-3 text-xs font-semibold text-slate-700">More</button>
        </div>
        {classic && <div className="mobile-sample-scroll mt-2 flex gap-2 overflow-x-auto pb-0.5">
          <span className="flex shrink-0 items-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">Try</span>
          {SAMPLE_SUBJECTS.map((sample) => (
            <button key={sample.id} type="button" disabled={session.busy} onClick={() => { void session.insertSample(sample.id); }} className="min-h-9 shrink-0 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm disabled:opacity-40">
              {sample.label}
            </button>
          ))}
        </div>}
      </header>

      <CheckpointCard variant="mobile" checkpoint={session.checkpoint} evidence={session.lastEvidence} />

      <TutorQuestionCard key={session.tutor.question?.qid ?? "none"} variant="mobile" question={session.tutor.question} busy={session.busy} cardRect={session.tutor.cardRect} onAnswer={session.tutor.answer} onListen={session.tutor.hush}
        hints={session.tutor.hints.given} hintBusy={session.tutor.hints.busy} onHint={session.tutor.hints.next} />

      <div className="pointer-events-auto fixed inset-x-0 bottom-0 z-50 y-glass border-x-0 border-b-0 px-3 pb-[calc(.65rem+env(safe-area-inset-bottom))] pt-2">
        <div className="mx-auto mb-2 max-w-md">
          <TutorComposer variant="mobile" tutor={session.tutor} blocked={session.busy && !session.tutor.busy} onStop={session.stop} />
        </div>
        <div className="mx-auto flex max-w-md items-center gap-2">
          <button type="button" onClick={() => setProfileOpen(true)} aria-label={`Open learning profile, ${observations} observations`} className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-indigo-200 bg-indigo-50 text-xs font-bold text-indigo-700">Learn</button>
          <PlacesMenu session={session} interfaceMode={interfaceMode} variant="mobile" />
          {classic && <><button type="button" onClick={primaryAction} className={`min-h-12 flex-1 rounded-2xl px-4 text-base font-bold text-white shadow-lg transition active:scale-[.98] ${session.busy ? "bg-rose-500 shadow-rose-200" : session.checkpoint ? "bg-violet-600 shadow-violet-200" : "bg-emerald-600 shadow-emerald-200"}`}>
            {primaryLabel}
          </button>
          <button type="button" onClick={session.clearBoard} disabled={session.busy} aria-label="Clear board" className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-slate-200 bg-white text-lg text-slate-600 disabled:opacity-40">⌫</button></>}
        </div>
        {classic && <p className="mt-1 text-center text-[10px] text-slate-400">{session.checkpoint ? "Write your answer on the board, then check it." : "Draw or choose a sample, then ask Y to teach it."}</p>}
      </div>

      {classic && <ChatPanel
        variant="mobile"
        messages={session.chatMessages}
        busy={session.chatBusy}
        disabled={session.busy}
        sttAvailable={session.sttAvailable}
        sttModel={session.sttModel}
        onSend={(text) => { void session.sendChatMessage(text); }}
        onClear={session.clearChat}
        onCancel={session.cancelChat}
      />}

      <MobileLearnerSheet open={profileOpen} snapshot={session.learnerSnapshot} onClose={() => setProfileOpen(false)} onReset={() => { void session.resetLearner(); }} />

      {moreOpen && (
        <div className="pointer-events-auto fixed inset-0 z-[85] flex items-end bg-slate-950/35" onClick={() => setMoreOpen(false)}>
          <section role="dialog" aria-modal="true" aria-label="More controls" onClick={(event) => event.stopPropagation()} className="mobile-sheet w-full rounded-t-[28px] bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 shadow-2xl">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-950">Demo controls</h2>
              <button type="button" onClick={() => setMoreOpen(false)} className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 text-xl">×</button>
            </div>
            {!eventMode && (
              <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Tutor model
                <select value={session.modelChoice} onChange={(event) => session.changeModel(event.target.value as ModelChoice)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800">
                  {MODEL_CHOICES.map((model) => <option key={model.id} value={model.id} disabled={session.modelReady[model.id] === false}>{model.label}</option>)}
                </select>
              </label>
            )}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={session.toggleTts} className={`min-h-12 rounded-xl border text-sm font-semibold ${session.ttsEnabled ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-200 text-slate-700"}`}>Narration {session.ttsEnabled ? "on" : "off"}</button>
              <button type="button" onClick={session.replay} disabled={!session.hasReplay || session.busy} className="min-h-12 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-40">Replay lesson</button>
              <button type="button" onClick={() => interfaceMode.setMode("studio")} className="min-h-12 rounded-xl border border-indigo-200 bg-indigo-50 text-sm font-semibold text-indigo-700">Open Studio UI</button>
              <CanvasList />
              <button type="button" onClick={interfaceMode.useAutomaticMode} className="min-h-12 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Use device default</button>
            </div>
            <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">Mobile Demo keeps the same lesson, learner profile, and canvas as Studio. Only the controls change.</p>
          </section>
        </div>
      )}
    </div>
  );
}
