// Illustrations for `image` moves. The server starts the Muse Image job when it accepts the move;
// the board shows a placeholder at once and the browser polls the job, then swaps in an image
// element carrying provenance. A failed or slow image leaves a caption; the lesson never waits.
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import type { WhiteboardHandle } from "@/components/Whiteboard";

export const IMAGE_SOURCE = "muse-image-1.0";
export const POLL_MS = 1500;
export const DEADLINE_MS = 45_000;

export interface ImageStatus { image_id: string; status: "pending" | "ready" | "failed"; asset_hash: string | null; alt: string; error: string | null }
interface Pending { image_id: string; alt: string; status: string }

export const placeholderId = (imageId: string) => `y-image-${imageId}`;

export async function fetchImageStatus(session: string, imageId: string, signal?: AbortSignal): Promise<ImageStatus | null> {
  try {
    const response = await fetch(`/api/learning/sessions/${session}/images/${imageId}`, { credentials: "same-origin", cache: "no-store", signal });
    return response.ok ? (await response.json() as ImageStatus) : null;
  } catch {
    return null;
  }
}

async function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

function caption(handle: WhiteboardHandle, imageId: string, text: string, status: string) {
  const id = placeholderId(imageId);
  const frame = handle.getElements().find((e) => e.id === id);
  if (!frame) return;
  handle.mutateElement(`${id}-text`, { text, originalText: text });
  handle.mutateElement(id, { customData: { ...frame.customData, yImage: { ...(frame.customData?.yImage as object), status } } });
}

/** Swap the placeholder for the finished image. False while a turn is drawing elsewhere (retry later). */
async function insert(handle: WhiteboardHandle, session: string, status: ImageStatus): Promise<boolean> {
  const id = placeholderId(status.image_id);
  const frame = handle.getElements().find((e) => e.id === id);
  if (!frame || !status.asset_hash) return true; // the learner removed it: nothing to place
  const blob = await fetch(`/api/learning/sessions/${session}/board/assets/${status.asset_hash}`, { credentials: "same-origin" })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("asset"))));
  const fileId = `y-img-${status.asset_hash.slice(0, 24)}` as FileId;
  const files: BinaryFiles = { [fileId]: { id: fileId, dataURL: (await dataUrl(blob)) as DataURL, mimeType: "image/webp", created: Date.now() } };
  const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
  const [image] = convertToExcalidrawElements([{ type: "image", id: `${id}-img`, fileId, x: frame.x, y: frame.y,
    width: frame.width, height: frame.height,
    customData: { yAssetHash: status.asset_hash, yImage: { image_id: status.image_id, alt: status.alt, source: IMAGE_SOURCE, creator: "model" } } }],
  { regenerateIds: false });
  try {
    handle.addFiles(files);
    handle.appendElements([image], "model");
  } catch {
    return false;
  }
  handle.mutateElement(`${id}-text`, { isDeleted: true });
  handle.mutateElement(id, { isDeleted: true });
  return true;
}

/** Poll one job until it is placed, failed or past the deadline. Safe to call twice for the same id. */
const watching = new Set<string>();
export async function watchImage(handle: WhiteboardHandle, session: string, imageId: string, signal?: AbortSignal,
  deadlineMs = DEADLINE_MS): Promise<"ready" | "failed" | "gone"> {
  if (watching.has(imageId)) return "gone";
  watching.add(imageId);
  const started = Date.now();
  try {
    while (!signal?.aborted && Date.now() - started < deadlineMs) {
      await sleep(POLL_MS, signal);
      if (!handle.getElements().some((e) => e.id === placeholderId(imageId))) continue; // not drawn yet
      const status = await fetchImageStatus(session, imageId, signal);
      if (status?.status === "failed") {
        caption(handle, imageId, `Illustration unavailable. ${status.alt}`, "failed");
        return "failed";
      }
      if (status?.status === "ready" && await insert(handle, session, status).catch(() => false)) {
        console.debug("[tutor] image", JSON.stringify({ image_id: imageId, placed_ms: Date.now() - started }));
        return "ready";
      }
    }
    if (!signal?.aborted && handle.getElements().some((e) => e.id === placeholderId(imageId))) {
      caption(handle, imageId, "Illustration still painting. It will appear when you reopen this board.", "pending");
    }
    return "gone";
  } finally {
    watching.delete(imageId);
  }
}

/** Placeholders saved while their image was pending (for example before a refresh). */
export function pendingImages(handle: WhiteboardHandle): string[] {
  return handle.getElements().flatMap((e) => {
    const value = e.customData?.yImage as Pending | undefined;
    return e.id === placeholderId(value?.image_id ?? "") && value?.status === "pending" ? [value.image_id] : [];
  });
}
