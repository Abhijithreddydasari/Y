import type { Batch, BoardEdit, BoardState } from "./board-api";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export interface Draft { base: BoardState; pending: BoardEdit[]; flight: Batch | null; files: BinaryFiles }
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("y-board-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
export async function readDraft(id: string): Promise<Draft | undefined> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction("drafts").objectStore("drafts").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function writeDraft(id: string, draft: Draft): Promise<void> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const tx = connection.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put(draft, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
