"use client";

// Entry points to "Mind" (the learner map). The map's code loads only on intent (hover, focus, touch) or open,
// and the map is portalled to <body> above every board layer; `useMindFresh` reports a session sealed since the
// map was last seen (the "new" dot on the Places arc).
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SEEN_KEY } from "./seen";

const MindOverlay = dynamic(() => import("./MindOverlay"), { ssr: false });
export const preloadMind = () => { void import("./MindOverlay"); void import("./MindScene"); };

/** True when a profile revision newer than the last one seen in Mind exists. Checked when idle, never while open. */
export function useMindFresh(open: boolean): [boolean, () => void] {
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
  return [fresh, () => setFresh(false)];
}

/** The map itself, portalled above the board. */
export function MindView({ onClose }: { onClose: () => void }) {
  return createPortal(<MindOverlay onClose={onClose} />, document.body);
}

/** A doodled brain: one line-art outline, the midline and four folds. */
export const MIND_ICON = "M12 5.2c-1-1.4-3.3-1.6-4.6-.3-1.6-.2-3 1.1-3 2.7-1.3.6-1.9 2.2-1.2 3.5-.8 1.2-.5 2.9.7 3.6 0 1.7 1.5 3 3.2 2.8 1 1.2 2.9 1.4 4 .4 1.1 1 3 .8 4-.4 1.7.2 3.2-1.1 3.2-2.8 1.2-.7 1.5-2.4.7-3.6.7-1.3.1-2.9-1.2-3.5 0-1.6-1.4-2.9-3-2.7-1.3-1.3-3.6-1.1-4.6.3ZM12 5.2v12.6M8.2 9.2c1 .2 1.6.9 1.6 1.9M7 13.4c1.1-.4 2.2 0 2.8.9M15.8 9.2c-1 .2-1.6.9-1.6 1.9M17 13.4c-1.1-.4-2.2 0-2.8.9";
