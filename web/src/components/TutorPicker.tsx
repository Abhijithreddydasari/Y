"use client";

import { useEffect, useId, useRef, useState } from "react";
import { optionLabel, type TutorOption, type TutorOptions, type TutorPrefs, type TutorTrace } from "@/lib/tutor-options";

interface Props {
  options: TutorOptions | null;
  prefs: TutorPrefs;
  /** The model that answered the latest turn, shown so a switch is visible in the trace. */
  trace: TutorTrace | null;
  onModel: (id: string) => void;
  onVoice: (id: string) => void;
  /** Icon-only trigger for narrow composers; the menu still names both choices. */
  compact?: boolean;
}

const short = (label: string) => label.replace(/^Muse /, "").replace(" · think more", " +");

function Group({ title, items, value, onPick }: { title: string; items: TutorOption[]; value: string; onPick: (id: string) => void }) {
  return (
    <div role="group" aria-label={title} className="py-1">
      <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400">{title}</div>
      {items.map((option) => {
        const active = option.id === value;
        return (
          <button key={option.id} type="button" role="menuitemradio" aria-checked={active} disabled={!option.available}
            title={option.reason ?? undefined} onClick={() => onPick(option.id)}
            className={`flex w-full items-start gap-2 rounded-lg px-3 py-1.5 text-left transition-colors enabled:hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 ${active ? "bg-violet-50" : ""}`}>
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-violet-600" : "bg-transparent"}`} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-slate-800">{option.label}</span>
              <span className="block text-[11px] leading-snug text-slate-500">{option.available ? option.note : option.reason}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Model and voice switcher inside the composer, like a chat app's model menu.
 *  The menu anchors to the nearest positioned ancestor (the composer form), so it never leaves the screen. */
export default function TutorPicker({ options, prefs, trace, onModel, onVoice, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  if (!options) return null;
  const model = optionLabel(options, "models", prefs.model), voice = optionLabel(options, "voices", prefs.voice);
  const answered = trace && trace.option !== prefs.model ? optionLabel(options, "models", trace.option) : null;

  return (
    <div ref={root} className="shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}
        title={`Tutor: ${model} · Voice: ${voice}`} aria-label={`Tutor ${model}, voice ${voice}`}
        className="flex min-h-10 max-w-[11rem] items-center gap-1 rounded-xl px-2 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800">
        {compact ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
            <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="10.5" cy="4.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5.5" cy="11.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        ) : <span className="truncate">{short(model)} · {voice}</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2 6.5 5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Tutor and voice"
          className="absolute bottom-full right-0 z-50 mb-2 w-[min(18rem,100%)] rounded-2xl border border-slate-200 bg-white/95 p-1 shadow-[0_18px_50px_rgba(15,23,42,.18)] backdrop-blur-xl">
          <Group title="Tutor" items={options.models} value={prefs.model} onPick={(id) => { onModel(id); setOpen(false); }} />
          <div className="mx-3 border-t border-slate-100" />
          <Group title="Voice" items={options.voices} value={prefs.voice} onPick={(id) => { onVoice(id); setOpen(false); }} />
          <p className="px-3 pb-2 pt-1 text-[11px] text-slate-400">
            {answered ? `Last answer came from ${answered}. ` : ""}A new tutor answers from the next turn; a new voice from the next sentence.
          </p>
        </div>
      )}
    </div>
  );
}
