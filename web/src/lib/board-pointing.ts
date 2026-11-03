// Rings for `point` moves. The server has already mapped the model's crop point to board space and
// snapped it to the learner's ink line (`at`); here it becomes a stroke-only ellipse around that ink,
// with a short label beside it. Learner elements are never moved, resized or covered.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import type { Rect } from "./board-api";

export const POINT_COLOR = "#e8590c";
export const POINT_KIND = "point";
const LABEL_SIZE = 18;
const GAP = 12;

export interface PointMove { type: "point"; label: string; line: number; at?: Rect; snap?: "line" | "nearest" | "raw" }

export const isPointElement = (e: { customData?: Record<string, unknown> }) =>
  (e.customData?.ySemantic as { kind?: string } | undefined)?.kind === POINT_KIND;

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The label's box: right of the ring, else above, else below; the first spot that touches no other element. */
export function labelSpot(at: Rect, text: string, others: Rect[]): Rect {
  const w = Math.min(320, Math.max(60, text.length * LABEL_SIZE * 0.55)), h = LABEL_SIZE * 1.35;
  const spots = [{ x: at.x + at.w + GAP, y: at.y + at.h / 2 - h / 2, w, h }, { x: at.x, y: at.y - h - 6, w, h },
    { x: at.x, y: at.y + at.h + 6, w, h }];
  return spots.find((s) => !others.some((o) => overlaps(s, o))) ?? spots[0];
}

/** Excalidraw skeletons for one ring; ids are stable per turn and move so a redraw never duplicates. */
export function pointSkeletons(move: PointMove, id: string, others: Rect[]) {
  if (!move.at) return [];
  const at = move.at;
  const custom = { ySemantic: { kind: POINT_KIND, label: move.label, line: move.line, snap: move.snap ?? null } };
  // An ellipse inscribed in a box cuts its corners; √2 times the box keeps every corner inside.
  const rx = at.w * Math.SQRT1_2 + 2, ry = at.h * Math.SQRT1_2 + 2, cx = at.x + at.w / 2, cy = at.y + at.h / 2;
  const ring = { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry };
  const label = labelSpot(ring, move.label, others);
  return [
    { type: "ellipse" as const, id, x: ring.x, y: ring.y, width: ring.w, height: ring.h, strokeColor: POINT_COLOR,
      backgroundColor: "transparent", fillStyle: "solid" as const, strokeWidth: 2, roughness: 1, opacity: 90, customData: custom },
    { type: "text" as const, id: `${id}-label`, x: label.x, y: label.y, text: move.label, fontSize: LABEL_SIZE,
      strokeColor: POINT_COLOR, customData: custom },
  ];
}

export function boxOf(e: Pick<ExcalidrawElement, "x" | "y" | "width" | "height">): Rect {
  const x = Math.min(e.x, e.x + e.width), y = Math.min(e.y, e.y + e.height);
  return { x, y, w: Math.abs(e.width), h: Math.abs(e.height) };
}

/** Draw one ring through the board handle as `model`; returns the new element ids (none if already drawn). */
export async function drawPoint(handle: Pick<WhiteboardHandle, "getElements" | "appendElements">, move: PointMove, id: string): Promise<string[]> {
  const scene = handle.getElements();
  if (!move.at || scene.some((e) => e.id === id)) return [];
  const others = scene.filter((e) => !e.isDeleted).map(boxOf);
  const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
  const els = convertToExcalidrawElements(pointSkeletons(move, id, others), { regenerateIds: false });
  handle.appendElements(els, "model");
  return els.map((e) => e.id);
}

/**
 * Where an answer's feedback starts: just under the answered card when that area holds nothing, so the
 * reply sits beside the work it answers; otherwise null (use the builder's area to the right of everything).
 */
export function belowCard(elements: readonly Pick<ExcalidrawElement, "id" | "x" | "y" | "width" | "height" | "isDeleted">[],
  cardId: string, area = { w: 900, h: 600 }): { x: number; y: number } | null {
  const card = elements.find((e) => e.id === cardId && !e.isDeleted);
  if (!card) return null;
  // 110 px leaves room for the "You answered…" note the card gains (up to 92 px) once the answer is accepted.
  const spot = { x: card.x, y: card.y + Math.abs(card.height) + 110, w: area.w, h: area.h };
  return elements.some((e) => !e.isDeleted && overlaps(boxOf(e), spot)) ? null : { x: spot.x, y: spot.y };
}
