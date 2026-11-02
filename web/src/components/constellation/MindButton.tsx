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
          className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-700">
          {icon}{fresh && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-300 ring-2 ring-white" />}
        </button>
      ) : (
        <button type="button" aria-label={label} onPointerEnter={preload} onFocus={preload} onTouchStart={preload} onClick={() => setOpen(true)}
          className="pointer-events-auto fixed left-3 top-[64px] z-40 flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white/95 px-2.5 text-[12px] font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:bg-slate-50 motion-reduce:transition-none">
          {icon}<span>Mind</span>{fresh && <span className="h-2 w-2 rounded-full bg-amber-300" aria-hidden="true" />}
        </button>
      )}
      {open && createPortal(<MindOverlay onClose={() => { setOpen(false); setFresh(false); }} />, document.body)}
    </>
  );
}

/** A doodled brain: one line-art outline, the midline and four folds, in the text colour. */
function MindGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5.2c-1-1.4-3.3-1.6-4.6-.3-1.6-.2-3 1.1-3 2.7-1.3.6-1.9 2.2-1.2 3.5-.8 1.2-.5 2.9.7 3.6 0 1.7 1.5 3 3.2 2.8 1 1.2 2.9 1.4 4 .4 1.1 1 3 .8 4-.4 1.7.2 3.2-1.1 3.2-2.8 1.2-.7 1.5-2.4.7-3.6.7-1.3.1-2.9-1.2-3.5 0-1.6-1.4-2.9-3-2.7-1.3-1.3-3.6-1.1-4.6.3Z" />
      <path d="M12 5.2v12.6M8.2 9.2c1 .2 1.6.9 1.6 1.9M7 13.4c1.1-.4 2.2 0 2.8.9M15.8 9.2c-1 .2-1.6.9-1.6 1.9M17 13.4c-1.1-.4-2.2 0-2.8.9" />
    </svg>
  );
}
