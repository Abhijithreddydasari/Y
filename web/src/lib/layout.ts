// Layout helpers: pick a region for the answer that does not overlap whatever
// the student already drew on the canvas. Phase 0 uses a simple bounding-box
// heuristic; if their content is on the left/top, we put the answer on the
// right/below. The renderer then stacks its primitives within that region.

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Generous default answer region. Excalidraw is an infinite canvas, so we just
// need somewhere far enough from the student that nothing collides.
export const ANSWER_REGION_W = 900;
export const ANSWER_REGION_H = 1200;
const PAD = 80;

export function getStudentBbox(elements: readonly ExcalidrawElement[]): Rect | null {
  if (elements.length === 0) return null;
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const el of elements) {
    if (el.isDeleted) continue;
    const w = (el as { width?: number }).width ?? 0;
    const h = (el as { height?: number }).height ?? 0;
    xMin = Math.min(xMin, el.x);
    yMin = Math.min(yMin, el.y);
    xMax = Math.max(xMax, el.x + w);
    yMax = Math.max(yMax, el.y + h);
  }
  if (!isFinite(xMin)) return null;
  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
}

// Pick a top-left corner for the answer such that the answer region (a
// roughly ANSWER_REGION_W x ANSWER_REGION_H rectangle) does not overlap the
// student bounding box. Strategy:
//   - empty canvas        -> origin (0,0)
//   - wider than tall     -> below (same x, below ymax)
//   - taller than wide    -> right (right of xmax, same y)
//   - default             -> right
export function getAnswerRegion(studentBbox: Rect | null): Rect {
  if (!studentBbox) {
    return { x: 0, y: 0, w: ANSWER_REGION_W, h: ANSWER_REGION_H };
  }
  const tallerThanWide = studentBbox.h >= studentBbox.w * 0.75;
  if (tallerThanWide) {
    return {
      x: studentBbox.x + studentBbox.w + PAD,
      y: studentBbox.y,
      w: ANSWER_REGION_W,
      h: ANSWER_REGION_H,
    };
  }
  return {
    x: studentBbox.x,
    y: studentBbox.y + studentBbox.h + PAD,
    w: ANSWER_REGION_W,
    h: ANSWER_REGION_H,
  };
}
