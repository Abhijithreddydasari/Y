"use client";

// Entry point to "Mind" (the learner map) for both shells. The map's code loads only on intent (hover, focus,
// touch) or open, and the map is portalled to <body> above every board layer; a "new" dot appears once a session has been sealed since the map was last seen.
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SEEN_KEY } from "./seen";

const MindOverlay = dynamic(() => import("./MindOverlay"), { ssr: false });
const preload = () => { void import("./MindOverlay"); void import("./MindScene"); };

export default function MindButton({ variant = "studio" }: { variant?: "studio" | "mobile" }) {
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    if (open) return;
    let cancelled = false;
    const check = () => {
      fetch("/api/learning/profile", { cache: "no-store", credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { revision?: { revision?: number } | null } | null) => {
          let seen = 0;
          try { seen = Number(localStorage.getItem(SEEN_KEY) ?? 0); } catch { /* storage blocked */ }
          const latest = body?.revision?.revision ?? 0;
          if (!cancelled) setFresh(latest > seen);
        })
        .catch(() => { /* the dot is optional */ });
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(check) : window.setTimeout(check, 1500);
    return () => { cancelled = true; if (!idle) window.clearTimeout(handle); };
  }, [open]);

  const label = fresh ? "Open Mind, your learner map (new session saved)" : "Open Mind, your learner map";
  const icon = <MindGlyph />;
  return (
    <>
      {variant === "mobile" ? (
        <button type="button" aria-label={label} onPointerEnter={preload} onFocus={preload} onTouchStart={preload} onClick={() => setOpen(true)}
          className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-violet-300/60 bg-[#151824] text-violet-200">
          {icon}{fresh && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-300 ring-2 ring-[#151824]" />}
        </button>
      ) : (
        <button type="button" aria-label={label} onPointerEnter={preload} onFocus={preload} onTouchStart={preload} onClick={() => setOpen(true)}
          className="pointer-events-auto fixed left-3 top-[68px] z-40 flex h-11 items-center gap-2 rounded-2xl border border-white/15 bg-[rgba(17,20,30,.86)] px-3.5 text-[13px] font-semibold text-violet-100 shadow-[0_14px_40px_rgba(15,23,42,.35)] backdrop-blur-xl transition hover:bg-[rgba(24,28,42,.92)] motion-reduce:transition-none">
          {icon}<span>Mind</span>{fresh && <span className="h-2 w-2 rounded-full bg-amber-300" aria-hidden="true" />}
        </button>
      )}
      {open && createPortal(<MindOverlay onClose={() => { setOpen(false); setFresh(false); }} />, document.body)}
    </>
  );
}

/** A brain outline holding a small cited network: three neurons, two synapses, one spike. */
function MindGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M8 18.6c-2.9-.3-4.6-2.6-4.1-5-1-1.4-.7-3.6.9-4.4.1-2.5 2.2-4.1 4.5-3.8 1.2-1.3 3.4-1.7 5-.8 2.2-.4 4.4.9 4.9 3.1 1.7.9 2.3 3 1.5 4.6.4 2.2-1 4.2-3.2 4.4-.8 1.5-2.6 2.2-4.2 1.7l-.5 2.1"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".9" />
      <path d="M8.6 12.2 12.3 9.1M12.3 9.1l3.4 4" stroke="#7F77DD" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8.6" cy="12.2" r="1.7" fill="#5DCAA5" />
      <circle cx="12.3" cy="9.1" r="1.5" fill="#AFA9EC" />
      <circle cx="15.7" cy="13.1" r="1.9" fill="#F0997B" />
      <circle cx="14.1" cy="11.2" r=".75" fill="#FAC775" />
    </svg>
  );
}
