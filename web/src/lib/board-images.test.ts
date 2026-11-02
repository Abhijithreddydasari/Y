import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardHandle } from "@/components/Whiteboard";
import { pendingImages, placeholderId, watchImage } from "./board-images";
import { LessonRenderer } from "./renderer";
import { moveToPrimitive } from "./tutor-turn";

vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: (skeletons: unknown[]) => skeletons }));

const ID = "a".repeat(32);
const HASH = "b".repeat(64);
type El = { id: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; customData?: Record<string, unknown>; text?: string };

function board(elements: El[]) {
  const handle = {
    getElements: () => elements.filter((e) => !e.isDeleted),
    mutateElement: vi.fn((id: string, patch: Partial<El>) => { const e = elements.find((x) => x.id === id); if (e) Object.assign(e, patch); }),
    appendElements: vi.fn((els: El[], actor?: string) => { void actor; elements.push(...els); }),
    addFiles: vi.fn(),
  };
  return handle as unknown as WhiteboardHandle & typeof handle;
}

const placeholder = (): El[] => [
  { id: placeholderId(ID), x: 10, y: 20, width: 420, height: 280, customData: { yImage: { image_id: ID, alt: "A lens", status: "pending" } } },
  { id: `${placeholderId(ID)}-text`, x: 30, y: 140, width: 380, height: 48, text: "Painting…" },
];

function respond(statuses: object[]) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes("/board/assets/")) return new Response(new Blob([new Uint8Array([82, 73, 70, 70])], { type: "image/webp" }));
    return Response.json(statuses.length > 1 ? statuses.shift() : statuses[0]);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("image moves", () => {
  it("map to a placeholder primitive only when the server started a job", async () => {
    expect(moveToPrimitive({ type: "image", prompt: "p", alt: "A lens", image_id: ID })).toEqual({ tag: "image", args: { id: ID, alt: "A lens" } });
    expect(moveToPrimitive({ type: "image", prompt: "p", alt: "A lens" })).toBeNull();
    const { skeletons } = await new LessonRenderer({ x: 0, y: 0 }).render({ tag: "image", args: { id: ID, alt: "A lens" } });
    expect(skeletons[0]).toMatchObject({ id: placeholderId(ID), strokeStyle: "dashed", customData: { yImage: { image_id: ID, status: "pending" } } });
    expect((await new LessonRenderer({ x: 0, y: 0 }).render({ tag: "image", args: { id: "../x", alt: "" } })).skeletons).toEqual([]);
  });

  it("swap the placeholder for an image element with provenance once ready", async () => {
    const elements = placeholder();
    const handle = board(elements);
    respond([{ image_id: ID, status: "pending" }, { image_id: ID, status: "ready", asset_hash: HASH, alt: "A lens", error: null }]);
    expect(await watchImage(handle, "sid", ID)).toBe("ready");
    const [image] = handle.appendElements.mock.calls[0][0] as unknown as El[];
    expect(image).toMatchObject({ type: "image", x: 10, y: 20, width: 420, height: 280,
      customData: { yAssetHash: HASH, yImage: { image_id: ID, source: "muse-image-1.0", creator: "model", alt: "A lens" } } });
    expect(handle.appendElements.mock.calls[0][1]).toBe("model");
    expect(handle.addFiles).toHaveBeenCalledOnce();
    expect(elements.find((e) => e.id === placeholderId(ID))?.isDeleted).toBe(true);
  });

  it("leave a caption when the image fails, without touching the rest of the board", async () => {
    const elements = placeholder();
    const handle = board(elements);
    respond([{ image_id: ID, status: "failed", asset_hash: null, alt: "A lens", error: "image_timeout" }]);
    expect(await watchImage(handle, "sid", ID)).toBe("failed");
    expect(elements[1].text).toBe("Illustration unavailable. A lens");
    expect(handle.appendElements).not.toHaveBeenCalled();
    expect(pendingImages(handle)).toEqual([]);
  });

  it("do not place an image whose placeholder the learner deleted", async () => {
    const elements = placeholder();
    const handle = board(elements);
    const fetcher = respond([{ image_id: ID, status: "ready", asset_hash: HASH, alt: "A lens", error: null }]);
    elements.forEach((e) => { e.isDeleted = true; });
    vi.useFakeTimers();
    const watched = watchImage(handle, "sid", ID, undefined, 4000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await watched).toBe("gone");
    expect(fetcher).not.toHaveBeenCalled();
    expect(handle.appendElements).not.toHaveBeenCalled();
  });

  it("retry later while another turn is drawing, and resume pending placeholders after a refresh", async () => {
    const elements = placeholder();
    const handle = board(elements);
    expect(pendingImages(handle)).toEqual([ID]);
    handle.appendElements.mockImplementationOnce(() => { throw new Error("The tutor response exceeded its drawing area."); });
    respond([{ image_id: ID, status: "ready", asset_hash: HASH, alt: "A lens", error: null }]);
    expect(await watchImage(handle, "sid", ID)).toBe("ready");
    expect(handle.appendElements).toHaveBeenCalledTimes(2);
  });
});
