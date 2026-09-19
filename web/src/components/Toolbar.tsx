"use client";

import { type ChangeEvent, useState } from "react";

export type ModelChoice = "openai" | "edge" | "edge-ft" | "cloud";

export const MODEL_CHOICES: { id: ModelChoice; label: string; subtitle: string }[] = [
  { id: "openai", label: "OpenAI (GPT-5.6)", subtitle: "Canvas is sent to OpenAI" },
  { id: "edge", label: "Edge (E4B)", subtitle: "gemma4:e4b on Ollama" },
  { id: "edge-ft", label: "Edge fine-tuned (E4B+LoRA)", subtitle: "y-gemma4 ControlSketch LoRA" },
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
  narrating: boolean;
  status: string;
  ttsEnabled: boolean;
  teacherMode: boolean;
  modelChoice: ModelChoice;
  modelReady?: Partial<Record<ModelChoice, boolean>>;
  canReplay: boolean;
  canAssess: boolean;
  voice: string;
  onSolve: () => void;
  onAssess: () => void;
  onClear: () => void;
  onInsertSample: (subject: SampleSubject) => void;
  onReplay: () => void;
  onStop: () => void;
  onToggleTts: () => void;
  onToggleTeacherMode: () => void;
  onModelChange: (model: ModelChoice) => void;
  onVoiceChange: (voice: string) => void;
  onSwitchInterface?: () => void;
}

export default function Toolbar({
  busy,
  status,
  ttsEnabled,
  teacherMode,
  modelChoice,
  modelReady,
  canReplay,
  canAssess,
  voice,
  onSolve,
  onAssess,
  onClear,
  onInsertSample,
  onReplay,
  onStop,
  onToggleTts,
  onToggleTeacherMode,
  onModelChange,
  onVoiceChange,
  onSwitchInterface,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const handleModelSelect = (e: ChangeEvent<HTMLSelectElement>) => {
    onModelChange(e.target.value as ModelChoice);
  };
  const primaryAction = busy ? onStop : canAssess ? onAssess : onSolve;
  const primaryLabel = busy ? "Stop" : canAssess ? "Check answer" : "Teach me";

  return (
    <div className="pointer-events-none absolute right-3 top-20 z-30 min-[1100px]:right-4 min-[1100px]:top-4">
      <div className="pointer-events-auto w-[260px] rounded-2xl border border-slate-200/80 bg-white/95 p-3 shadow-[0_14px_45px_rgba(15,23,42,.14)] backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-400 font-black text-slate-950">Y</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-950">Studio</p>
            <p className="truncate text-[11px] text-slate-500" aria-live="polite">{status}</p>
          </div>
          <button type="button" onClick={() => setMoreOpen((open) => !open)} className="min-h-11 rounded-xl px-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">More</button>
        </div>

        <button type="button" onClick={primaryAction} className={`mt-3 min-h-12 w-full rounded-xl text-sm font-bold text-white shadow-sm ${busy ? "bg-rose-500" : canAssess ? "bg-violet-600" : "bg-emerald-600"}`}>
          {primaryLabel}
        </button>

        <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
          {SAMPLE_SUBJECTS.map((sample) => (
            <button key={sample.id} type="button" onClick={() => onInsertSample(sample.id)} disabled={busy} className="min-h-9 shrink-0 rounded-full bg-slate-100 px-2.5 text-[11px] font-medium text-slate-700 disabled:opacity-40">
              {sample.label}
            </button>
          ))}
        </div>

        {moreOpen && (
          <div className="mt-2 space-y-2 border-t border-slate-100 pt-3">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={onClear} disabled={busy} className="min-h-11 rounded-xl bg-slate-100 text-xs font-semibold text-slate-700 disabled:opacity-40">Clear</button>
              <button type="button" onClick={onReplay} disabled={busy || !canReplay} className="min-h-11 rounded-xl bg-slate-100 text-xs font-semibold text-slate-700 disabled:opacity-40">Replay</button>
              <button type="button" onClick={onToggleTts} className="min-h-11 rounded-xl bg-slate-100 text-xs font-semibold text-slate-700">Narration {ttsEnabled ? "on" : "off"}</button>
              <button type="button" onClick={onToggleTeacherMode} className="min-h-11 rounded-xl bg-slate-100 text-xs font-semibold text-slate-700">Teacher {teacherMode ? "on" : "off"}</button>
            </div>
            <select value={modelChoice} onChange={handleModelSelect} aria-label="Tutor model" className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-700">
              {MODEL_CHOICES.map((model) => <option key={model.id} value={model.id} disabled={modelReady?.[model.id] === false}>{model.label}</option>)}
            </select>
            {ttsEnabled && (
              <select value={voice} onChange={(event) => onVoiceChange(event.target.value)} aria-label="Narration voice" className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-700">
                <option value="kokoro_af_heart">Voice: Heart</option>
                <option value="kokoro_am_michael">Voice: Michael</option>
              </select>
            )}
            {onSwitchInterface && <button type="button" onClick={onSwitchInterface} className="min-h-11 w-full rounded-xl border border-indigo-200 text-xs font-semibold text-indigo-700">Mobile view</button>}
          </div>
        )}
      </div>
    </div>
  );
}
