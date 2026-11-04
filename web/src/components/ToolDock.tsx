"use client";

// Y's drawing tools: one glass dock at the top centre, in place of Excalidraw's toolbar (hidden while the dock is
// mounted). It drives Excalidraw's own tools, so shortcuts keep working and the dock follows them. Ink and thickness
// are remembered across tools and reloads, including choices made in Excalidraw's own style panel.
import { useEffect, useRef, useState } from "react";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import { hasWidth, INKS, TOOLS, updateToolMemory, useToolMemory, WIDTHS, type ToolId } from "@/lib/board-tools";

export default function ToolDock({ board }: { board: WhiteboardHandle | null }) {
  const [tool, setTool] = useState<ToolId | null>("selection");
  const memory = useToolMemory();
  const memoryRef = useRef(memory);
  useEffect(() => { memoryRef.current = memory; }, [memory]);

  useEffect(() => {
    document.documentElement.dataset.toolDock = "on";
    return () => { delete document.documentElement.dataset.toolDock; };
  }, []);
  useEffect(() => board?.onToolChange(setTool), [board]);
  // The saved pen is ready for the P shortcut too, not only for a press on the dock.
  useEffect(() => { board?.setStyle(memoryRef.current.ink, memoryRef.current.widths.pen); }, [board]);
  useEffect(() => board?.onStyleChange((changed, color, width) => {
    const { ink, widths } = memoryRef.current;
    if (hasWidth(changed) && widths[changed] !== width && WIDTHS.some((w) => w.value === width)) updateToolMemory({ widths: { ...memoryRef.current.widths, [changed]: width } });
    if ((changed === "pen" || changed === "text" || changed === "rectangle" || changed === "arrow") && color !== ink && /^#[0-9a-f]{6}$/i.test(color)) updateToolMemory({ ink: color });
  }), [board]);

  const pick = (next: ToolId, ink = memory.ink, widths = memory.widths) => {
    setTool(next);
    board?.setTool(next, ink, hasWidth(next) ? widths[next] : undefined);
  };
  const inked = tool === "pen" || tool === "text" || tool === "rectangle" || tool === "arrow";
  const sized = hasWidth(tool) ? tool : "pen";

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
      <div role="group" aria-label="Ink colour" className="flex items-center gap-1">
        {INKS.map((c) => (
          <button key={c.hex} type="button" aria-label={`${c.label} ink`} aria-pressed={memory.ink === c.hex}
            onClick={() => { updateToolMemory({ ink: c.hex }); pick(inked ? tool! : "pen", c.hex); }}
            className={`h-6 w-6 rounded-full border-2 border-white transition ${memory.ink === c.hex ? "ring-2 ring-slate-900" : "ring-1 ring-slate-900/20 hover:scale-110"}`}
            style={{ background: c.hex }} />
        ))}
      </div>
      <span className="mx-1 h-6 w-px bg-slate-900/10" aria-hidden="true" />
      <div role="group" aria-label="Thickness" className="flex items-center pr-1">
        {WIDTHS.map((w, index) => {
          const on = memory.widths[sized] === w.value;
          return (
            <button key={w.value} type="button" aria-label={`${w.label} line`} aria-pressed={on} title={w.label}
              onClick={() => { const widths = { ...memory.widths, [sized]: w.value }; updateToolMemory({ widths }); pick(sized, memory.ink, widths); }}
              className={`grid h-8 w-8 place-items-center rounded-full transition ${on ? "bg-slate-900/10" : "hover:bg-white/70"}`}>
              <span aria-hidden="true" className="block rounded-full bg-slate-800" style={{ width: 4 + index * 4, height: 4 + index * 4 }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
