"use client";

// The trace drawer, portalled above the board. Its code loads only when opened (or on intent via preloadTrace).
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import type { TutorTimeline } from "@/lib/tutor-turn";

const TraceDrawer = dynamic(() => import("./TraceDrawer"), { ssr: false });
export const preloadTrace = () => { void import("./TraceDrawer"); };

export default function TraceView({ timing, onClose }: { timing: TutorTimeline | null; onClose: () => void }) {
  return createPortal(<TraceDrawer timing={timing} onClose={onClose} />, document.body);
}
