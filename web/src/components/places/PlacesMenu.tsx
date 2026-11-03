"use client";

// The board is home; the Y button fans out the places reachable from it (Mind, Canvases, Review, End session,
// Trace, Settings). One place is open at a time, and each loads its own code only when opened.
import { useState } from "react";
import { CanvasDialog } from "@/components/CanvasList";
import { MIND_ICON, MindView, preloadMind, useMindFresh } from "@/components/constellation/MindEntry";
import RadialMenu, { type ArcItem } from "@/components/places/RadialMenu";
import ReviewSheet from "@/components/places/ReviewSheet";
import SettingsSheet from "@/components/places/SettingsSheet";
import TraceView, { preloadTrace } from "@/components/trace/TraceView";
import type { useInterfaceMode } from "@/hooks/useInterfaceMode";
import type { TutorSession } from "@/hooks/useTutorSession";

type Place = "mind" | "canvases" | "review" | "trace" | "settings";

interface Props {
  session: TutorSession;
  interfaceMode: ReturnType<typeof useInterfaceMode>;
  variant?: "studio" | "mobile";
}

export default function PlacesMenu({ session, interfaceMode, variant = "studio" }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [fresh, seen] = useMindFresh(place === "mind");
  const { tutor } = session;
  const due = tutor.sealed ? 0 : tutor.warmup.items.length;

  const items: ArcItem[] = [
    { id: "mind", label: "Mind", hint: "your learner map", icon: MIND_ICON, badge: fresh ? "new" : undefined, onIntent: preloadMind,
      onSelect: () => { seen(); setPlace("mind"); } },
    { id: "canvases", label: "Canvases", hint: "saved boards", icon: "M4 7h11v12H4zM8 4h12v12", onSelect: () => setPlace("canvases") },
    { id: "review", label: "Review", hint: due ? `${due} due` : "nothing due", icon: "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M12 8v4l3 2",
      badge: due || undefined, onSelect: () => setPlace("review") },
    { id: "end", label: tutor.ending ? "Saving…" : "End session", hint: "save to Mind", icon: "M6 4h12v16l-6-4-6 4z",
      disabled: tutor.busy || tutor.ending || tutor.sealed || tutor.configured === false, onSelect: tutor.endSession },
    { id: "trace", label: "Trace", hint: "models and timing", icon: "M3 12h4l3-7 4 14 3-7h4", onIntent: preloadTrace,
      onSelect: () => setPlace("trace") },
    { id: "settings", label: "Settings", hint: "memory, voice, layout",
      icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
      onSelect: () => setPlace("settings") },
  ];
  const close = () => setPlace(null);

  return (
    <>
      <RadialMenu items={items} open={open} onOpenChange={setOpen} label="Places: Mind, Canvases, Review and more"
        // Studio: bottom-right corner, fanning left and up. Mobile: from the bottom bar, fanning up and right.
        from={variant === "mobile" ? -95 : 180} to={variant === "mobile" ? -15 : 270} radius={variant === "mobile" ? 150 : 132}
        className={variant === "mobile" ? "relative" : "fixed bottom-16 right-5"}
        button={<span className="relative grid h-10 w-10 place-items-center rounded-full bg-slate-900 text-lg font-black text-amber-200">
          Y{(fresh || due > 0) && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-amber-400" />}
        </span>} />
      {place === "mind" && <MindView onClose={close} />}
      {place === "canvases" && <CanvasDialog onClose={close} onNew={tutor.newSession} />}
      {place === "review" && <ReviewSheet tutor={tutor} onClose={close} />}
      {place === "trace" && <TraceView timing={tutor.timing} onClose={close} />}
      {place === "settings" && <SettingsSheet session={session} interfaceMode={interfaceMode} onClose={close} />}
    </>
  );
}
