"use client";

// Opens the trace drawer. Its code loads only on intent or open, so the board pays nothing for it.
import dynamic from "next/dynamic";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { TutorTimeline } from "@/lib/tutor-turn";

const TraceDrawer = dynamic(() => import("./TraceDrawer"), { ssr: false });
const preload = () => { void import("./TraceDrawer"); };

/** A pill in the composer row (both shells), beside Memory and End session. */
export default function TraceButton({ timing }: { timing: TutorTimeline | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-label="Trace: models and latency" onPointerEnter={preload} onFocus={preload} onTouchStart={preload}
        onClick={() => setOpen(true)}
        className="y-glass flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold text-slate-700">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2 4h7M2 8h11M2 12h5" /><circle cx="11" cy="4" r="1.4" /><circle cx="9" cy="12" r="1.4" />
        </svg>
        Trace
      </button>
      {open && createPortal(<TraceDrawer timing={timing} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
