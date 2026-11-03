"use client";

// Y's drawing tools: one glass dock at the top centre, in place of Excalidraw's toolbar (hidden while the dock is
// mounted). It drives Excalidraw's own tools, so shortcuts keep working and the dock follows them.
import { useEffect, useState } from "react";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import { INKS, TOOLS, type ToolId } from "@/lib/board-tools";

export default function ToolDock({ board }: { board: WhiteboardHandle | null }) {
  const [tool, setTool] = useState<ToolId | null>("selection");
  const [ink, setInk] = useState(INKS[0].hex);

  useEffect(() => {
    document.documentElement.dataset.toolDock = "on";
    return () => { delete document.documentElement.dataset.toolDock; };
  }, []);
  useEffect(() => board?.onToolChange(setTool), [board]);

  const pick = (next: ToolId, color = ink) => { setTool(next); board?.setTool(next, color); };
  const inked = tool === "pen" || tool === "text" || tool === "rectangle" || tool === "arrow";

  return (
    <div role="toolbar" aria-label="Drawing tools" className="y-glass pointer-events-auto fixed left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full p-1.5">
      {TOOLS.map((t) => (
        <button key={t.id} type="button" aria-label={t.key ? `${t.label} (${t.key})` : t.label} aria-pressed={tool === t.id} title={t.key ? `${t.label} · ${t.key}` : t.label}
          onClick={() => pick(t.id)}
          className={`grid h-10 w-10 place-items-center rounded-full transition ${tool === t.id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-white/70"}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
        </button>
      ))}
      <span className="mx-1 h-6 w-px bg-slate-900/10" aria-hidden="true" />
      <div role="group" aria-label="Ink colour" className="flex items-center gap-1 pr-1">
        {INKS.map((c) => (
          <button key={c.hex} type="button" aria-label={`${c.label} ink`} aria-pressed={ink === c.hex}
            onClick={() => { setInk(c.hex); pick(inked ? tool! : "pen", c.hex); }}
            className={`h-6 w-6 rounded-full border-2 border-white transition ${ink === c.hex ? "ring-2 ring-slate-900" : "ring-1 ring-slate-900/20 hover:scale-110"}`}
            style={{ background: c.hex }} />
        ))}
      </div>
    </div>
  );
}
