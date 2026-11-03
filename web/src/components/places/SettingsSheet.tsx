"use client";

// Settings: the switches that used to sit around the composer and in the old Studio card. The tutor model and
// voice stay in the composer's picker, where they apply from the next turn.
import { useEffect, type ReactNode } from "react";
import type { useInterfaceMode } from "@/hooks/useInterfaceMode";
import type { TutorSession } from "@/hooks/useTutorSession";
import { setClassicTools, useClassicTools } from "@/lib/classic";

interface Props { session: TutorSession; interfaceMode: ReturnType<typeof useInterfaceMode>; onClose: () => void }

function Switch({ label, detail, on, disabled, onChange }: { label: string; detail: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-14 cursor-pointer items-center gap-3 py-1">
      <span className="flex-1">
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        <span className="block text-xs text-slate-500">{detail}</span>
      </span>
      <input type="checkbox" role="switch" aria-label={label} checked={on} disabled={disabled} onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 accent-indigo-600" />
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">{title}</h3>
      <div className="divide-y divide-slate-900/5">{children}</div>
    </div>
  );
}

export default function SettingsSheet({ session, interfaceMode, onClose }: Props) {
  const classic = useClassicTools();
  const { tutor } = session;

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-[90] grid place-items-center bg-slate-950/25 p-4" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Settings" onClick={(event) => event.stopPropagation()}
        className="y-glass-strong flex max-h-[84dvh] w-[min(460px,100%)] flex-col gap-4 overflow-y-auto rounded-[28px] p-5">
        <header className="flex items-center">
          <h2 className="text-xl font-bold text-slate-950">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="ml-auto grid h-10 w-10 place-items-center rounded-full bg-slate-900/5 text-lg">×</button>
        </header>
        <Section title="Tutor">
          <Switch label="Memory" detail="Use what Mind knows about you in this session" on={tutor.memory.on} disabled={tutor.busy}
            onChange={tutor.memory.set} />
          <Switch label="Narration" detail="Y speaks each step after drawing it" on={session.ttsEnabled} onChange={() => session.toggleTts()} />
          <p className="py-2 text-xs text-slate-500">Model and voice are in the menu beside Ask.</p>
        </Section>
        <Section title="Layout">
          <div role="group" aria-label="Layout" className="my-2 grid grid-cols-3 rounded-xl bg-slate-900/5 p-0.5 text-xs font-semibold">
            {(["studio", "mobile"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={interfaceMode.mode === mode} onClick={() => interfaceMode.setMode(mode)}
                className={`rounded-[10px] py-2 capitalize ${interfaceMode.mode === mode ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>{mode}</button>
            ))}
            <button type="button" onClick={interfaceMode.useAutomaticMode} className="rounded-[10px] py-2 text-slate-600">Device</button>
          </div>
          <Switch label="Classic tools" detail="Show Teach me, Practice, samples and the old chat" on={classic} onChange={setClassicTools} />
        </Section>
      </section>
    </div>
  );
}
