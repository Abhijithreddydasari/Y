"use client";

// Settings: the switches that used to sit around the composer and in the old Studio card. The tutor model and
// voice stay in the composer's picker, where they apply from the next turn.
import { useState, type ReactNode } from "react";
import PlaceSheet from "@/components/places/PlaceSheet";
import type { useInterfaceMode } from "@/hooks/useInterfaceMode";
import type { TutorSession } from "@/hooks/useTutorSession";
import { setClassicTools, useClassicTools } from "@/lib/classic";
import { firstName, resetPersona, switchProfile, type PersonaListing } from "@/lib/personas";

interface Props {
  session: TutorSession; interfaceMode: ReturnType<typeof useInterfaceMode>; onClose: () => void;
  personas?: { listing: PersonaListing | null; error: string };
}

/** "Try as…": your own profile or a demo learner's private copy; plus which mind End session saves into. */
function TryAs({ listing, error, session }: { listing: PersonaListing | null; error: string; session: TutorSession }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const { tutor } = session;
  if (error) return <p className="py-2 text-xs text-slate-500">{error}</p>;
  if (!listing) return <p className="py-2 text-xs text-slate-500">Loading learners…</p>;
  const run = (work: () => Promise<void>) => {
    setBusy(true); setFailed("");
    work().catch(() => { setFailed("That didn't work. Try again in a moment."); setBusy(false); });
  };
  const options = [{ key: null, name: "Your own", blurb: "Your own anonymous profile on this browser", topics: [] as string[] },
    ...listing.personas];
  const current = listing.personas.find((p) => p.key === listing.active);
  const own = current ? `${firstName(current)}'s mind` : "your own mind";
  const targets = [{ into: "", name: own }, ...(current ? [{ into: "own", name: "your own mind" }] : []),
    ...listing.personas.filter((p) => p.key !== listing.active).map((p) => ({ into: p.key, name: `${firstName(p)}'s mind` }))];
  return (
    <div className="py-2">
      <div role="radiogroup" aria-label="Try as" className="flex flex-col gap-1.5">
        {options.map((p) => {
          const on = p.key === listing.active;
          return (
            <button key={p.key ?? "own"} type="button" role="radio" aria-checked={on} disabled={busy || tutor.busy || tutor.ending}
              onClick={() => { if (!on) run(() => switchProfile(p.key)); }}
              className={`rounded-xl border px-3 py-2 text-left transition ${on ? "border-indigo-500 bg-indigo-50" : "border-slate-900/10 bg-white/70 hover:bg-white"}`}>
              <span className="block text-sm font-semibold text-slate-900">{p.name}{on && <span className="ml-2 text-xs font-medium text-indigo-600">active</span>}</span>
              <span className="block text-xs text-slate-500">{p.blurb}</span>
              {p.topics.length > 0 && <span className="mt-0.5 block text-[11px] text-slate-400">{p.topics.join(" · ")}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Demo learners have seeded history (authored sessions, notes recorded from Muse Spark 1.3). Picking one gives you a private copy; what you learn as them stays in your copy.</p>
      {current && (
        <button type="button" disabled={busy} className="mt-2 rounded-lg border border-slate-900/10 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
          onClick={() => { if (window.confirm(`Reset ${current.name} to the start? Sessions you added as ${firstName(current)} are discarded.`)) run(() => resetPersona(current.key)); }}>
          Reset {firstName(current)}
        </button>
      )}
      <label className="mt-3 flex items-center gap-2 text-sm">
        <span className="flex-1">
          <span className="block font-semibold text-slate-900">End session saves to</span>
          <span className="block text-xs text-slate-500">Seal this board into another of your minds</span>
        </span>
        <select aria-label="End session saves to" value={tutor.saveTo.value?.into ?? ""} disabled={tutor.ending || tutor.sealed}
          onChange={(event) => { const t = targets.find((x) => x.into === event.target.value); tutor.saveTo.set(t && t.into ? t : null); }}
          className="rounded-lg border border-slate-900/10 bg-white px-2 py-1 text-xs">
          {targets.map((t) => <option key={t.into || "this"} value={t.into}>{t.into ? t.name : `This board (${t.name})`}</option>)}
        </select>
      </label>
      {failed && <p role="alert" className="mt-1 text-xs text-rose-600">{failed}</p>}
    </div>
  );
}

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

export default function SettingsSheet({ session, interfaceMode, onClose, personas }: Props) {
  const classic = useClassicTools();
  const { tutor } = session;

  return (
    <PlaceSheet title="Settings" subtitle="Learner, tutor, voice and layout" width="w-[min(460px,100%)]" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {personas && <Section title="Try as…"><TryAs listing={personas.listing} error={personas.error} session={session} /></Section>}
        <Section title="Tutor">
          <Switch label="Memory" detail="Use what Mind knows about you in this session" on={tutor.memory.on} disabled={tutor.busy}
            onChange={tutor.memory.set} />
          <Switch label="Narration" detail="Y speaks each step after drawing it" on={session.ttsEnabled} onChange={() => session.toggleTts()} />
          <p className="py-2 text-xs text-slate-500">Model and voice are in the menu beside Ask.</p>
        </Section>
        <Section title="Layout">
          <div role="group" aria-label="Layout" className="my-2 grid grid-cols-2 rounded-xl bg-slate-900/5 p-0.5 text-xs font-semibold">
            {(["studio", "mobile"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={interfaceMode.mode === mode} onClick={() => interfaceMode.setMode(mode)}
                className={`rounded-[10px] py-2 capitalize ${interfaceMode.mode === mode ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>{mode}</button>
            ))}
          </div>
          <Switch label="Classic tools" detail="Show Teach me, Practice, samples and the old chat" on={classic} onChange={setClassicTools} />
        </Section>
      </div>
    </PlaceSheet>
  );
}
