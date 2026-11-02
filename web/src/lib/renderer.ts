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
import { WIDGET_SCHEME, parseWidget, widgetSize } from "@/components/widgets/widget-spec";
import { renderLatexToImage } from "./katex";
import { placeholderId } from "./board-images";
import { diagramLabels, mermaidToBoard } from "./mermaid-board";
import { parseSvg, rasterSvgToPng, type ParsedSvg } from "./svg";
import type { PrimitiveTag } from "./types";

export interface RenderResult {
  skeletons: ExcalidrawElementSkeleton[];
  files?: BinaryFiles;
  /**
   * If set, the player should mutate the element with this id to
   * progressively reveal `revealText` in lockstep with TTS.
   * `revealWidth`/`revealHeight` MUST be included in every mutation patch
   * to prevent Excalidraw from auto-resizing the element as text grows.
   */
  revealId?: string;
  revealText?: string;
  revealWidth?: number;
  revealHeight?: number;
  /**
   * If set, the player should run a stroke-by-stroke reveal of the SVG diagram
   * before swapping in the rasterised image. `parsedSvg` exposes the parsed
   * paths and total stroke length so the player can pace the animation.
   */
  drawAnimation?: {
    parsedSvg: ParsedSvg;
    /** Excalidraw image element id holding the rasterised PNG. */
    imageId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    caption?: string;
  };
  /** Ids of placeholder rectangles the player turns into widget embeddables after conversion. */
  embeddables?: string[];
}

const COL_WIDTH = 620;
const COLUMN_GAP = 70;
const MAX_COLUMN_HEIGHT = 760;
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

interface DiagramSession {
  viewBox: string;
  x: number;
  y: number;
  width: number;
  height: number;
  partsSoFar: number;
}

export class LessonRenderer {
  private readonly origin: Origin;
  // Vertical cursor for the narration column (title / text / equation).
  private narrationY: number;
  private narrationX: number;
  private narrationColumn = 0;
  // Top-left of the diagram zone (boxes / nodes / lines / arrows).
  private readonly diagramOriginY: number;
  // Next slot in the 3-column diagram grid.
  private graphCol = 0;
  private graphRow = 0;
  // Local-id -> Excalidraw element id (we keep them identical via regenerateIds:false).
  private readonly idMap = new Map<string, string>();
  // When the model emits a sequence of [draw_part] blocks with a shared
  // viewBox we keep them at the same x/y so each part's image stacks on top
  // of the previous (rendered with transparent background) and the diagram
  // builds up as the teacher narrates. The session resets when (a) the next
  // primitive is not a draw_part, or (b) the viewBox changes.
  private diagramSession: DiagramSession | null = null;

  constructor(origin: Origin) {
    this.origin = origin;
    this.narrationX = origin.x;
    this.narrationY = origin.y;
    // Diagram zone starts a bit below the initial narration column. Pushed
    // down as title/equations are added (see advanceNarration).
    this.diagramOriginY = origin.y + 600;
  }

  async render(tag: PrimitiveTag): Promise<RenderResult> {
    if (tag.tag !== "draw_part") {
      // Any non-part primitive ends the current composing diagram.
      this.diagramSession = null;
    }
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
      case "draw":
        return this.renderDraw(tag.args);
      case "draw_part":
        return this.renderDrawPart(tag.args);
      case "card":
        return this.renderCard(tag.args);
      case "diagram":
        return this.renderDiagram(asStr(tag.args.mermaid));
      case "widget":
        return this.renderWidget(asStr(tag.args.kind), asStr(tag.args.spec));
      case "image":
        return this.renderImagePlaceholder(asStr(tag.args.id), asStr(tag.args.alt));
      default:
        return { skeletons: [] };
    }
  }

  private advanceNarration(height: number): void {
    this.narrationY += height + 14;
    if (this.narrationY - this.origin.y > MAX_COLUMN_HEIGHT) {
      this.narrationColumn += 1;
      this.narrationX = this.origin.x + this.narrationColumn * (COL_WIDTH + COLUMN_GAP);
      this.narrationY = this.origin.y;
    }
  }

  private renderTitle(text: string): RenderResult {
    if (!text) return { skeletons: [] };
    const id = makeRevealId();
    const lines = Math.max(1, text.split("\n").length);
    const height = Math.ceil(TITLE_FONT * TITLE_LINE_H * lines) + 8;
    // Virgil (fontFamily 1) averages ~0.75 em per char at this size.
    const width = Math.max(COL_WIDTH, Math.ceil(text.length * TITLE_FONT * 0.75));
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
      autoResize: false,
    } as ExcalidrawElementSkeleton;
    this.advanceNarration(height + 12);
    return { skeletons: [skel], revealId: id, revealText: text, revealWidth: width, revealHeight: height };
  }

  private renderText(text: string): RenderResult {
    if (!text) return { skeletons: [] };
    const wrapped = wrapText(text, 50);
    const lines = wrapped.split("\n").length;
    const id = makeRevealId();
    const height = Math.ceil(NARRATION_FONT * NARRATION_LINE_H * lines) + 4;
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
      autoResize: false,
    } as ExcalidrawElementSkeleton;
    this.advanceNarration(height);
    return { skeletons: [skel], revealId: id, revealText: wrapped, revealWidth: COL_WIDTH, revealHeight: height };
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
        customData: { ySemantic: { kind: "equation", latex } },
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

  private async renderDraw(args: Record<string, string | number>): Promise<RenderResult> {
    const innerSvg = asStr(args.svg);
    if (!innerSvg) return { skeletons: [] };
    const viewBoxStr = asStr(args.viewBox, "0 0 400 300");
    const w = Math.min(asNum(args.w) ?? 400, COL_WIDTH);
    const caption = asStr(args.caption);
    return this.renderInlineSvg(innerSvg, viewBoxStr, w, caption);
  }

  /**
   * `draw_part` is a single named part of a larger diagram. Consecutive
   * [draw_part] blocks with the same viewBox compose into one cumulative
   * diagram: each part image is rasterised with a transparent background and
   * stacked at the same on-canvas position, so the user sees strokes appear
   * one stroke-set at a time exactly as a teacher would draw on a board.
   * `name` is spoken aloud by the player so the student hears "now the bonds"
   * as the bond strokes fill in.
   */
  private async renderDrawPart(args: Record<string, string | number>): Promise<RenderResult> {
    const innerSvg = asStr(args.svg);
    if (!innerSvg) return { skeletons: [] };
    const viewBoxStr = asStr(args.viewBox, "0 0 400 300");
    const requestedW = Math.min(asNum(args.w) ?? 400, COL_WIDTH);
    const partName = asStr(args.name);

    const parsed = parseSvg(innerSvg, viewBoxStr);

    let session = this.diagramSession;
    let isFirstPart = false;
    if (!session || session.viewBox !== viewBoxStr) {
      const [, , vbW, vbH] = parsed.viewBox;
      const aspect = vbH / Math.max(1, vbW);
      const h = Math.max(60, Math.round(requestedW * aspect));
      const offsetX = (COL_WIDTH - requestedW) / 2;
      session = {
        viewBox: viewBoxStr,
        x: this.narrationX + offsetX,
        y: this.narrationY,
        width: requestedW,
        height: h,
        partsSoFar: 0,
      };
      this.diagramSession = session;
      isFirstPart = true;
    }

    let raster;
    try {
      raster = await rasterSvgToPng(parsed.outerSvg, session.width, session.height);
    } catch (exc) {
      console.warn("[renderer] draw_part raster failed", exc);
      return this.renderText(partName || "(diagram)");
    }

    const fileId = makeFileId();
    const imageId = makeRevealId();
    const imageSkel: ExcalidrawElementSkeleton = {
      type: "image",
      customData: { ySemantic: { kind: "diagram", svg: parsed.outerSvg, caption: partName } },
      id: imageId,
      fileId,
      x: session.x,
      y: session.y,
      width: session.width,
      height: session.height,
    } as ExcalidrawElementSkeleton;
    const fileData: BinaryFileData = {
      id: fileId,
      mimeType: "image/png",
      dataURL: raster.dataURL as DataURL,
      created: Date.now(),
    };
    const files: BinaryFiles = { [fileId]: fileData };
    session.partsSoFar += 1;

    // Only the FIRST part of a diagram session pushes the narration cursor
    // down. Subsequent parts overlay at the saved y so they compose on top.
    if (isFirstPart) {
      this.advanceNarration(session.height);
    }

    return {
      skeletons: [imageSkel],
      files,
      drawAnimation: {
        parsedSvg: parsed,
        imageId,
        x: session.x,
        y: session.y,
        width: session.width,
        height: session.height,
        caption: partName,
      },
    };
  }

  /**
   * Shared SVG -> PNG -> Excalidraw image element pipeline used by both
   * `[draw]` and `[draw_part]`. Returns drawAnimation metadata so the player
   * can stroke-reveal each <path> before the rasterised image swaps in.
   */
  private async renderInlineSvg(
    innerSvg: string,
    viewBoxStr: string,
    w: number,
    caption: string,
  ): Promise<RenderResult> {
    const parsed = parseSvg(innerSvg, viewBoxStr);
    const [, , vbW, vbH] = parsed.viewBox;
    const aspect = vbH / Math.max(1, vbW);
    const h = Math.max(60, Math.round(w * aspect));

    let raster;
    try {
      raster = await rasterSvgToPng(parsed.outerSvg, w, h);
    } catch (exc) {
      console.warn("[renderer] svg raster failed", exc);
      return this.renderText(caption || "(diagram)");
    }

    const fileId = makeFileId();
    const offsetX = (COL_WIDTH - w) / 2;
    const x = this.narrationX + offsetX;
    const y = this.narrationY;
    const imageId = makeRevealId();
    const imageSkel: ExcalidrawElementSkeleton = {
      type: "image",
      id: imageId,
      fileId,
      x,
      customData: { ySemantic: { kind: "diagram", svg: parsed.outerSvg, caption } },
      y,
      width: w,
      height: h,
    } as ExcalidrawElementSkeleton;
    const fileData: BinaryFileData = {
      id: fileId,
      mimeType: "image/png",
      dataURL: raster.dataURL as DataURL,
      created: Date.now(),
    };
    const files: BinaryFiles = { [fileId]: fileData };
    this.advanceNarration(h);

    const result: RenderResult = {
      skeletons: [imageSkel],
      files,
      drawAnimation: {
        parsedSvg: parsed,
        imageId,
        x,
        y,
        width: w,
        height: h,
        caption,
      },
    };

    if (caption) {
      const captionResult = this.renderText(caption);
      result.skeletons.push(...captionResult.skeletons);
      if (captionResult.files) {
        Object.assign(result.files!, captionResult.files);
      }
    }

    return result;
  }

  /**
   * A predict/check card: a framed question with lettered options, drawn beside the work.
   * The frame keeps the given id so the answer controls can anchor to it after a refresh.
   */
  private renderCard(args: Record<string, string | number>): RenderResult {
    const id = asStr(args.id);
    const q = asStr(args.q);
    if (!id || !q) return { skeletons: [] };
    const options = asStr(args.options).split("\n").filter(Boolean);
    const body = [wrapText(`${asStr(args.label, "Check")}: ${q}`, 52),
      ...options.map((option, i) => wrapText(`${String.fromCharCode(65 + i)}. ${option}`, 52))].join("\n");
    const lines = body.split("\n").length;
    const pad = 16;
    const height = Math.ceil(NARRATION_FONT * NARRATION_LINE_H * lines) + pad * 2;
    const x = this.narrationX, y = this.narrationY;
    this.advanceNarration(height + 8);
    return { skeletons: [
      { type: "rectangle", id, x, y, width: COL_WIDTH, height, strokeColor: "#6d28d9", backgroundColor: "#f5f3ff",
        fillStyle: "solid", roundness: { type: 3 } } as ExcalidrawElementSkeleton,
      { type: "text", id: `${id}-text`, x: x + pad, y: y + pad, text: body, fontSize: NARRATION_FONT, fontFamily: 1,
        strokeColor: STROKE, width: COL_WIDTH - pad * 2, height: height - pad * 2, autoResize: false } as ExcalidrawElementSkeleton,
    ] };
  }

  private async renderDiagram(source: string): Promise<RenderResult> {
    if (!source) return { skeletons: [] };
    try {
      const diagram = await mermaidToBoard(source, { x: this.narrationX, y: this.narrationY }, COL_WIDTH);
      this.advanceNarration(diagram.height + 10);
      return { skeletons: diagram.skeletons, files: Object.keys(diagram.files).length ? diagram.files : undefined };
    } catch (error) {
      // Never show a broken diagram: write its labels as one line instead.
      console.warn("[tutor] diagram fell back to text", error);
      const labels = diagramLabels(source);
      return labels.length ? this.renderText(labels.join(" → ")) : { skeletons: [] };
    }
  }

  private renderWidget(kind: string, raw: string): RenderResult {
    const widget = parseWidget(kind, raw);
    if (!widget) return this.renderText("(This interactive widget could not load.)");
    const { width, height } = widgetSize(widget);
    const id = `y-widget-${Date.now().toString(36)}-${(_textIdCounter += 1)}`;
    const x = this.narrationX + Math.max(0, (COL_WIDTH - width) / 2), y = this.narrationY;
    this.advanceNarration(height + 10);
    return {
      skeletons: [{ type: "rectangle", id, x, y, width, height, strokeColor: "#c4b5fd", backgroundColor: "#ffffff",
        fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: { type: 3 }, link: `${WIDGET_SCHEME}${id}`,
        customData: { yWidget: widget } } as ExcalidrawElementSkeleton],
      embeddables: [id],
    };
  }

  /** A dashed frame where the illustration will appear; board-images.ts swaps it for the image. */
  private renderImagePlaceholder(imageId: string, alt: string): RenderResult {
    if (!/^[0-9a-f]{32}$/.test(imageId)) return { skeletons: [] };
    const id = placeholderId(imageId), width = 420, height = 280; // Muse Image is 3:2
    const x = this.narrationX + (COL_WIDTH - width) / 2, y = this.narrationY;
    this.advanceNarration(height + 10);
    return { skeletons: [
      { type: "rectangle", id, x, y, width, height, strokeColor: "#a78bfa", backgroundColor: "#faf5ff", fillStyle: "solid",
        strokeStyle: "dashed", roughness: 0, roundness: { type: 3 },
        customData: { yImage: { image_id: imageId, alt, status: "pending" } } } as ExcalidrawElementSkeleton,
      { type: "text", id: `${id}-text`, x: x + 24, y: y + height / 2 - 24, width: width - 48, height: 48, text: wrapText(`Painting an illustration… ${alt}`, 40),
        fontSize: 16, fontFamily: 1, strokeColor: "#6d28d9", textAlign: "center", autoResize: false } as ExcalidrawElementSkeleton,
    ] };
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

export function wrapText(text: string, maxChars: number): string {
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
