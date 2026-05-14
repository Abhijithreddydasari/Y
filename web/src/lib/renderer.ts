// Convert parsed primitives into Excalidraw element skeletons + image files.
// Layout strategy (no animation yet):
//   - title/text/equation stack vertically in a column starting at the answer origin
//   - box/node are placed left-to-right in a 3-column grid below the narration column
//   - arrow uses Excalidraw's bound-to-shape feature (start.id / end.id)
//   - line uses raw coords offset from origin
// Coordinates emitted by the model (x/y/w/h/r/x1..) take precedence over our
// automatic layout when present.

import type { BinaryFileData, BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { renderLatexToImage } from "./katex";
import type { PrimitiveTag } from "./types";

export interface RenderResult {
  skeletons: ExcalidrawElementSkeleton[];
  files?: BinaryFiles;
  /**
   * If set, the player should mutate the element with this id (one of the
   * skeletons above) to progressively reveal `revealText` in lockstep with
   * TTS. Used for title/text primitives. Bounds are pre-computed at full
   * text size so the element does not jump as it fills in.
   */
  revealId?: string;
  revealText?: string;
}

const COL_WIDTH = 740;
const NARRATION_FONT = 18;
const TITLE_FONT = 30;
const NARRATION_LINE_H = 1.25;
const TITLE_LINE_H = 1.25;
const BOX_W = 140;
const BOX_H = 70;
const NODE_R = 38;
const GRAPH_GAP_X = 60;
const GRAPH_GAP_Y = 80;
const GRAPH_COLS = 3;
const STROKE = "#111111";

interface Origin {
  x: number;
  y: number;
}

function makeFileId(): FileId {
  return (Math.random().toString(36).slice(2) + Date.now().toString(36)) as FileId;
}

let _textIdCounter = 0;
function makeRevealId(): string {
  _textIdCounter += 1;
  return `y-reveal-${Date.now().toString(36)}-${_textIdCounter}`;
}

function asNum(v: string | number | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asStr(v: string | number | undefined, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

export class LessonRenderer {
  private readonly origin: Origin;
  // Vertical cursor for the narration column (title / text / equation).
  private narrationY: number;
  private readonly narrationX: number;
  // Top-left of the diagram zone (boxes / nodes / lines / arrows).
  private readonly diagramOriginY: number;
  // Next slot in the 3-column diagram grid.
  private graphCol = 0;
  private graphRow = 0;
  // Local-id -> Excalidraw element id (we keep them identical via regenerateIds:false).
  private readonly idMap = new Map<string, string>();

  constructor(origin: Origin) {
    this.origin = origin;
    this.narrationX = origin.x;
    this.narrationY = origin.y;
    // Diagram zone starts a bit below the initial narration column. Pushed
    // down as title/equations are added (see advanceNarration).
    this.diagramOriginY = origin.y + 600;
  }

  async render(tag: PrimitiveTag): Promise<RenderResult> {
    switch (tag.tag) {
      case "title":
        return this.renderTitle(asStr(tag.args.text));
      case "text":
        return this.renderText(asStr(tag.args.content));
      case "equation":
        return this.renderEquation(asStr(tag.args.latex));
      case "box":
        return this.renderBox(tag.args);
      case "node":
        return this.renderNode(tag.args);
      case "arrow":
        return this.renderArrow(tag.args);
      case "line":
        return this.renderLine(tag.args);
      default:
        return { skeletons: [] };
    }
  }

  private advanceNarration(height: number): void {
    this.narrationY += height + 14;
  }

  private renderTitle(text: string): RenderResult {
    if (!text) return { skeletons: [] };
    const id = makeRevealId();
    const lines = Math.max(1, text.split("\n").length);
    const height = TITLE_FONT * TITLE_LINE_H * lines;
    // Width is generous enough that mutating the text shorter never reflows
    // the element. Excalidraw uses our explicit width/height as the bounds.
    const width = Math.max(220, Math.ceil(text.length * TITLE_FONT * 0.6));
    const skel: ExcalidrawElementSkeleton = {
      type: "text",
      id,
      x: this.narrationX,
      y: this.narrationY,
      text,
      fontSize: TITLE_FONT,
      fontFamily: 1,
      strokeColor: STROKE,
      width,
      height,
    };
    this.advanceNarration(height + 12);
    return { skeletons: [skel], revealId: id, revealText: text };
  }

  private renderText(text: string): RenderResult {
    if (!text) return { skeletons: [] };
    const wrapped = wrapText(text, 60);
    const lines = wrapped.split("\n").length;
    const id = makeRevealId();
    const height = Math.ceil(NARRATION_FONT * NARRATION_LINE_H * lines);
    const skel: ExcalidrawElementSkeleton = {
      type: "text",
      id,
      x: this.narrationX,
      y: this.narrationY,
      text: wrapped,
      fontSize: NARRATION_FONT,
      fontFamily: 1,
      strokeColor: STROKE,
      width: COL_WIDTH,
      height,
    };
    this.advanceNarration(height);
    return { skeletons: [skel], revealId: id, revealText: wrapped };
  }

  private async renderEquation(latex: string): Promise<RenderResult> {
    if (!latex) return { skeletons: [] };
    try {
      const img = await renderLatexToImage(latex);
      const id = makeFileId();
      const drawW = Math.min(img.width, COL_WIDTH);
      const aspect = img.height / img.width;
      const drawH = drawW * aspect;
      const offsetX = (COL_WIDTH - drawW) / 2;
      const skel: ExcalidrawElementSkeleton = {
        type: "image",
        fileId: id,
        x: this.narrationX + offsetX,
        y: this.narrationY,
        width: drawW,
        height: drawH,
      };
      const fileData: BinaryFileData = {
        id,
        mimeType: "image/png",
        dataURL: img.dataURL as DataURL,
        created: Date.now(),
      };
      const files: BinaryFiles = { [id]: fileData };
      this.advanceNarration(drawH);
      return { skeletons: [skel], files };
    } catch (exc) {
      console.warn("[renderer] katex failed for", latex, exc);
      return this.renderText(latex);
    }
  }

  private nextGraphSlot(): { x: number; y: number } {
    const x = this.origin.x + this.graphCol * (BOX_W + GRAPH_GAP_X);
    const y = this.diagramOriginY + this.graphRow * (BOX_H + GRAPH_GAP_Y);
    this.graphCol += 1;
    if (this.graphCol >= GRAPH_COLS) {
      this.graphCol = 0;
      this.graphRow += 1;
    }
    return { x, y };
  }

  private renderBox(args: Record<string, string | number>): RenderResult {
    const id = asStr(args.id);
    if (!id) return { skeletons: [] };
    const w = asNum(args.w) ?? BOX_W;
    const h = asNum(args.h) ?? BOX_H;
    const slot = this.nextGraphSlot();
    const x = asNum(args.x) !== undefined ? this.origin.x + (asNum(args.x) as number) : slot.x;
    const y = asNum(args.y) !== undefined ? this.diagramOriginY + (asNum(args.y) as number) : slot.y;
    const label = asStr(args.label);
    this.idMap.set(id, id);
    const skel: ExcalidrawElementSkeleton = {
      type: "rectangle",
      id,
      x,
      y,
      width: w,
      height: h,
      strokeColor: STROKE,
      backgroundColor: "transparent",
      ...(label ? { label: { text: label, fontSize: 16 } } : {}),
    };
    return { skeletons: [skel] };
  }

  private renderNode(args: Record<string, string | number>): RenderResult {
    const id = asStr(args.id);
    if (!id) return { skeletons: [] };
    const r = asNum(args.r) ?? NODE_R;
    const slot = this.nextGraphSlot();
    const x = asNum(args.x) !== undefined ? this.origin.x + (asNum(args.x) as number) : slot.x;
    const y = asNum(args.y) !== undefined ? this.diagramOriginY + (asNum(args.y) as number) : slot.y;
    const label = asStr(args.label);
    this.idMap.set(id, id);
    const skel: ExcalidrawElementSkeleton = {
      type: "ellipse",
      id,
      x,
      y,
      width: r * 2,
      height: r * 2,
      strokeColor: STROKE,
      backgroundColor: "transparent",
      ...(label ? { label: { text: label, fontSize: 14 } } : {}),
    };
    return { skeletons: [skel] };
  }

  private renderArrow(args: Record<string, string | number>): RenderResult {
    const fromLocal = asStr(args.from);
    const toLocal = asStr(args.to);
    const fromId = this.idMap.get(fromLocal);
    const toId = this.idMap.get(toLocal);
    if (!fromId || !toId) {
      // Endpoint unknown - silently drop so the lesson keeps flowing.
      return { skeletons: [] };
    }
    const label = asStr(args.label);
    const skel: ExcalidrawElementSkeleton = {
      type: "arrow",
      x: 0,
      y: 0,
      strokeColor: STROKE,
      start: { id: fromId },
      end: { id: toId },
      ...(label ? { label: { text: label, fontSize: 14 } } : {}),
    };
    return { skeletons: [skel] };
  }

  private renderLine(args: Record<string, string | number>): RenderResult {
    const x1 = asNum(args.x1);
    const y1 = asNum(args.y1);
    const x2 = asNum(args.x2);
    const y2 = asNum(args.y2);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      return { skeletons: [] };
    }
    const label = asStr(args.label);
    const skel: ExcalidrawElementSkeleton = {
      type: "line",
      x: this.origin.x + x1,
      y: this.diagramOriginY + y1,
      strokeColor: STROKE,
      points: [
        [0, 0],
        [x2 - x1, y2 - y1],
      ],
      ...(label ? { label: { text: label, fontSize: 14 } } : {}),
    };
    return { skeletons: [skel] };
  }
}

function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      if (line.length === 0) {
        line = w;
      } else if ((line + " " + w).length <= maxChars) {
        line += " " + w;
      } else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
  }
  return lines.join("\n");
}
