import { describe, expect, it, vi } from "vitest";
import { belowCard, drawPoint, isPointElement, labelSpot, pointSkeletons, POINT_COLOR } from "./board-pointing";
import { moveToPrimitive, pointId } from "./tutor-turn";

vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: (skeletons: unknown[]) => skeletons }));

const at = { x: 100, y: 170, w: 200, h: 60 };
const move = { type: "point" as const, label: "20 - 5 is 15", line: 2, at, snap: "line" as const };

describe("pointing rings", () => {
  it("encloses every corner of the snapped ink box with a stroke-only ellipse", () => {
    const [ring, label] = pointSkeletons(move, "y-point-t-1", []);
    expect(ring).toMatchObject({ type: "ellipse", backgroundColor: "transparent", strokeColor: POINT_COLOR });
    const rx = ring.width! / 2, ry = ring.height! / 2, cx = ring.x + rx, cy = ring.y + ry;
    for (const [x, y] of [[at.x, at.y], [at.x + at.w, at.y], [at.x, at.y + at.h], [at.x + at.w, at.y + at.h]]) {
      expect(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2).toBeLessThan(1);
    }
    expect(label).toMatchObject({ type: "text", text: "20 - 5 is 15" });
    expect(isPointElement(ring)).toBe(true);
  });

  it("moves the label off other ink: right, then above, then below", () => {
    const ring = { x: 100, y: 100, w: 200, h: 60 };
    expect(labelSpot(ring, "here", []).x).toBeGreaterThan(300);
    const right = { x: 300, y: 90, w: 300, h: 80 };
    expect(labelSpot(ring, "here", [right]).y).toBeLessThan(100);
    const above = { x: 80, y: 40, w: 300, h: 55 };
    expect(labelSpot(ring, "here", [right, above]).y).toBeGreaterThan(160);
  });

  it("draws once as model and never touches existing elements", async () => {
    const ink = { id: "ink1", type: "freedraw", x: 100, y: 180, width: 200, height: 40, isDeleted: false };
    const scene: Record<string, unknown>[] = [ink];
    const handle = {
      getElements: () => scene as never,
      appendElements: vi.fn((els: readonly unknown[], actor?: string) => { expect(actor).toBe("model"); scene.push(...(els as never[])); }),
    };
    const ids = await drawPoint(handle, move, pointId("t", 1));
    expect(ids).toEqual(["y-point-t-1", "y-point-t-1-label"]);
    expect(await drawPoint(handle, move, pointId("t", 1))).toEqual([]);
    expect(handle.appendElements).toHaveBeenCalledTimes(1);
    expect(scene[0]).toBe(ink);
  });

  it("is not a layout primitive and needs a placement", async () => {
    expect(moveToPrimitive({ type: "point", crop: 0, x: 1, y: 1, line: 1, label: "x" })).toBeNull();
    const handle = { getElements: () => [] as never, appendElements: vi.fn() };
    expect(await drawPoint(handle, { type: "point", label: "x", line: 1 }, "y-point-u-0")).toEqual([]);
  });

  it("starts answer feedback under the answered card only when that space is empty", () => {
    const card = { id: "y-card-t.3", x: 800, y: 100, width: 620, height: 180, isDeleted: false };
    expect(belowCard([card], "y-card-t.3")).toEqual({ x: 800, y: 390 });
    const later = { id: "w", x: 900, y: 500, width: 200, height: 40, isDeleted: false };
    expect(belowCard([card, later], "y-card-t.3")).toBeNull();
    expect(belowCard([card, { ...later, isDeleted: true }], "y-card-t.3")).toEqual({ x: 800, y: 390 });
    expect(belowCard([card], "y-card-missing")).toBeNull();
  });
});
