"use client";

// Entry point to "Your mind" for both shells. The map's code loads only on intent (hover, focus,
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

  const label = fresh ? "Open your mind map, new session saved" : "Open your mind map";
  const icon = (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3.2 3.2 0 0 0 7.5 18 2.5 2.5 0 0 0 12 19.5V6a2 2 0 0 0-3-1.5Z" />
      <path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2 3.2 3.2 0 0 1-3.5 5.3 2.5 2.5 0 0 1-4.5 1.5" />
      <circle cx="9" cy="10" r="1" fill="currentColor" /><circle cx="15" cy="13" r="1" fill="currentColor" /><path d="M9.8 10.6 14.2 12.4" />
    </svg>
  );
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
          {icon}<span>Your mind</span>{fresh && <span className="h-2 w-2 rounded-full bg-amber-300" aria-hidden="true" />}
        </button>
      )}
      {open && createPortal(<MindOverlay onClose={() => { setOpen(false); setFresh(false); }} />, document.body)}
    </>
  );
}
