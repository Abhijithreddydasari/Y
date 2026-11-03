// Drawing tools for Y's own glass dock. Each maps onto an Excalidraw tool plus the pen style it uses;
// the dock replaces Excalidraw's toolbar (hidden by CSS under html[data-tool-dock]) but drives the same tools,
// so keyboard shortcuts keep working and the dock follows them.
export type ToolId = "selection" | "hand" | "pen" | "highlighter" | "eraser" | "text" | "rectangle" | "arrow";

export interface ToolDef { id: ToolId; label: string; key: string; icon: string }

export const TOOLS: ToolDef[] = [
  { id: "selection", label: "Select", key: "V", icon: "M5 3l14 8-6 2-2 6z" },
  { id: "hand", label: "Move the board", key: "H", icon: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-7.5a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.5 13a1.5 1.5 0 0 1 2.4-1.8L8 14" },
  { id: "pen", label: "Pen", key: "P", icon: "M4 20l4-1 11-11-3-3L5 16l-1 4zM14 6l3 3" },
  { id: "highlighter", label: "Highlighter", key: "", icon: "M8 14l7-7 3 3-7 7zM15 7l2-2 3 3-2 2M8 14l-4 5h6l1-2" },
  { id: "eraser", label: "Eraser", key: "E", icon: "M8 20h12M4 15l9-9 6 6-7 7H8z" },
  { id: "text", label: "Text", key: "T", icon: "M5 7V5h14v2M12 5v14M9 19h6" },
  { id: "rectangle", label: "Shape", key: "R", icon: "M4 5h16v14H4z" },
  { id: "arrow", label: "Arrow", key: "A", icon: "M5 19L19 5M10 5h9v9" },
];

export const INKS = [
  { hex: "#1e1e1e", label: "Black" }, { hex: "#1d4ed8", label: "Blue" }, { hex: "#dc2626", label: "Red" },
  { hex: "#15803d", label: "Green" }, { hex: "#7c3aed", label: "Violet" },
];
const HIGHLIGHT = "#facc15";

/** The Excalidraw tool and the pen style to apply for a dock tool. */
export function toolSettings(tool: ToolId, ink: string): { type: string; style?: Record<string, unknown> } {
  if (tool === "pen") return { type: "freedraw", style: { currentItemStrokeColor: ink, currentItemOpacity: 100, currentItemStrokeWidth: 2 } };
  if (tool === "highlighter") return { type: "freedraw", style: { currentItemStrokeColor: HIGHLIGHT, currentItemOpacity: 40, currentItemStrokeWidth: 4 } };
  // Other tools draw in the chosen ink at full opacity (undo a highlighter's style).
  return { type: tool, style: tool === "selection" || tool === "hand" || tool === "eraser" ? undefined : { currentItemStrokeColor: ink, currentItemOpacity: 100 } };
}

/** Which dock tool an Excalidraw state shows (a freedraw at highlighter opacity is the highlighter). */
export function toolOf(type: string, opacity: number): ToolId | null {
  if (type === "freedraw") return opacity < 100 ? "highlighter" : "pen";
  return TOOLS.some((t) => t.id === type) ? (type as ToolId) : null;
}
