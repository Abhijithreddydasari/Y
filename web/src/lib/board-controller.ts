import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { boardRequest, boardSession, BoardError, type Actor, type Batch, type BoardEdit, type BoardState, type ContextRequest, type Packet, type Rect, type Region } from "./board-api";
import { readDraft, writeDraft } from "./board-outbox";
import { isPointElement } from "./board-pointing";
import type { Assistance } from "./board-types";

const empty: BoardState = { revision: 0, records: {}, viewport: null, regions: [], active_region: null };
export function elementStamp(e: ExcalidrawElement): string { return `${e.version}:${e.versionNonce}:${e.isDeleted}`; }
/**
 * Saved records come back keyed by id. Put them in their saved stacking order, so what sat on top stays on top, with each
 * label directly after its container, as Excalidraw requires. Excalidraw renumbers any index left out of order.
 */
export function stackingOrder<T extends { id: string; index?: string | null; containerId?: string | null }>(elements: T[]): T[] {
  const sorted = [...elements].sort((a, b) => { const x = a.index ?? "", y = b.index ?? ""; return x < y ? -1 : x > y ? 1 : 0; });
  const ids = new Set(sorted.map(e => e.id));
  const labels = new Map<string, T[]>();
  for (const e of sorted) if (e.containerId && ids.has(e.containerId)) labels.set(e.containerId, [...labels.get(e.containerId) ?? [], e]);
  return sorted.flatMap(e => (e.containerId && ids.has(e.containerId) ? [] : [e, ...labels.get(e.id) ?? []]));
}
export function viewport(state: AppState): Rect {
  return { x: -state.scrollX, y: -state.scrollY, w: Math.max(1, state.width / state.zoom.value), h: Math.max(1, state.height / state.zoom.value) };
}

export class BoardController {
  session = "";
  state: BoardState = empty;
  ready = false;
  conflict = false;
  generationSource?: Packet["source"];
  generationArea?: Rect;
  onStaleSource?: () => void;
  private pending = new Map<string, BoardEdit>();
  private flight: Batch | null = null;
  private stamps = new Map<string, string>();
  private actor: Actor = "human";
  private source?: number;
  private debounce?: ReturnType<typeof setTimeout>;
  private maximum?: ReturnType<typeof setTimeout>;
  private durable?: ReturnType<typeof setTimeout>;
  private flushing: Promise<void> | null = null;
  private files: BinaryFiles = {};
  private disposed = false;
  private importNext = false;
  private savingDraft: Promise<void> = Promise.resolve();

  constructor(private api: ExcalidrawImperativeAPI, private status: (message: string) => void) {}

  async initialize(): Promise<void> {
    this.session = await boardSession();
    const [remote, draft] = await Promise.all([boardRequest<BoardState>(`sessions/${this.session}/board`), readDraft(this.session)]);
    this.state = remote;
    if (draft && (draft.flight || draft.pending.length)) {
      this.pending = new Map(draft.pending.map(e => [e.element.id, e]));
      this.flight = draft.flight;
      this.files = draft.files;
      // Lost acknowledgement is recoverable by operation ID. Other newer revisions are conflicts.
      this.state = draft.base;
      if (remote.revision !== draft.base.revision && remote.revision !== draft.base.revision + Number(Boolean(draft.flight))) this.conflict = true;
    }
    await this.restore();
    if (this.disposed) return;
    this.ready = true;
    if (this.conflict) this.status("Another tab changed this board. Local work is preserved; export it before reloading.");
    else if (this.pending.size || this.flight) await this.flush();
    else this.status("Board saved");
  }

  private async restore() {
    const elements = new Map(Object.values(this.state.records).map(r => [r.element.id, r.element]));
    for (const edit of [...this.flight?.edits ?? [], ...this.pending.values()]) elements.set(edit.element.id, edit.element);
    const assets = new Map<string, string>();
    for (const e of elements.values()) {
      const hash = e.customData?.yAssetHash;
      if (e.type === "image" && e.fileId && typeof hash === "string" && !this.files[e.fileId]) assets.set(e.fileId, hash);
    }
    // Bounded fan-out avoids one request per image starting at once.
    const entries = [...assets.entries()];
    for (let start = 0; start < entries.length; start += 4) {
      await Promise.all(entries.slice(start, start + 4).map(async ([fileId, hash]) => {
        const response = await fetch(`/api/learning/sessions/${this.session}/board/assets/${hash}`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("An image could not be restored. Retry before editing.");
        const blob = await response.blob();
        const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
        this.files[fileId] = { id: fileId, dataURL, mimeType: blob.type, created: 0 } as BinaryFiles[string];
      }));
    }
    if (this.disposed) return;
    const { restoreElements } = await import("@excalidraw/excalidraw");
    const restored = restoreElements(stackingOrder([...elements.values()] as (ExcalidrawElement & { containerId?: string | null })[]), null);
    for (const e of restored) this.stamps.set(e.id, elementStamp(e));
    this.api.addFiles(Object.values(this.files));
    const v = this.state.viewport;
    this.api.updateScene({ elements: restored, appState: v ? { scrollX: -v.x, scrollY: -v.y } : undefined });
  }

  mutate<T>(actor: Actor, operation: () => T, source?: number): T {
    const previous = this.actor, oldSource = this.source;
    this.actor = actor; this.source = source;
    try { return operation(); }
    finally {
      // Observe synchronously: React's onChange may otherwise arrive after the actor scope exits.
      this.observe(this.api.getSceneElementsIncludingDeleted(), this.api.getAppState(), this.api.getFiles());
      this.actor = previous; this.source = oldSource;
    }
  }

  markImport() { this.importNext = true; }
  get hasUnsaved() { return Boolean(this.flight || this.pending.size); }

  observe(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) {
    if (!this.ready || this.disposed) return;
    this.files = { ...this.files, ...files };
    let changed = false;
    const present = new Set(elements.map(e => e.id));
    const observed = [...elements];
    for (const [id, saved] of Object.entries(this.state.records)) {
      if (!present.has(id) && !saved.element.isDeleted) observed.push({ ...saved.element, isDeleted: true, version: saved.element.version + 1 });
    }
    for (const element of observed) {
      const stamp = elementStamp(element);
      if (this.stamps.get(element.id) === stamp) continue;
      this.stamps.set(element.id, stamp);
      const actor = this.importNext ? "unknown" : this.actor;
      let e = element;
      // Preserve semantic image sources on moves; invalidate after actual content edits.
      const previous = this.pending.get(e.id)?.element ?? this.state.records[e.id]?.element;
      if (actor === "human" && e.customData?.ySemantic && (!previous || (e.type === "text" && previous.type === "text" && e.text !== previous.text) ||
          (e.type === "image" && previous.type === "image" && e.fileId !== previous.fileId))) {
        const customData = { ...e.customData }; delete customData.ySemantic;
        e = { ...e, customData };
      }
      this.pending.set(e.id, { element: e, actor, source_revision: this.source });
      changed = true;
    }
    if (!changed) return;
    this.importNext = false;
    if (this.generationSource && !this.validSource(this.generationSource)) this.onStaleSource?.();
    this.status(this.conflict ? "Board conflict. Local changes are preserved." : "Saving board…");
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush().catch(() => {}), 750);
    this.maximum ??= setTimeout(() => void this.flush().catch(() => {}), 5000);
    clearTimeout(this.durable);
    this.durable = setTimeout(() => void this.persist().catch(() => this.status("Local recovery storage is unavailable. Keep this tab open.")), 150);
  }

  private persist() {
    const value = { base: this.state, flight: this.flight, pending: [...this.pending.values()], files: this.files };
    this.savingDraft = this.savingDraft.catch(() => {}).then(() => writeDraft(this.session, value));
    return this.savingDraft;
  }

  async flush(): Promise<void> {
    if (this.flushing) { await this.flushing; if (this.pending.size) return this.flush(); return; }
    if (!this.ready) throw new Error("Wait until the board has restored.");
    if (this.conflict) throw new Error("A newer board revision exists. Export local work before reloading.");
    clearTimeout(this.debounce); clearTimeout(this.maximum); this.maximum = undefined;
    this.flushing = this.save();
    try { await this.flushing; }
    catch (error) {
      if (error instanceof BoardError && error.status === 409) this.conflict = true;
      this.status(this.conflict ? "Board conflict. Export local work before reloading." : "Board is not synced. Local work is retained; retry saving.");
      throw error;
    } finally { this.flushing = null; }
    if (this.pending.size) return this.flush();
  }

  private async save() {
    if (!this.flight && !this.pending.size) return;
    if (!this.flight) {
      this.flight = { operation_id: crypto.randomUUID(), expected_revision: this.state.revision,
        edits: [...this.pending.values()], viewport: viewport(this.api.getAppState()) };
      this.pending.clear();
    }
    await this.persist();
    for (const edit of this.flight.edits) {
      const e = edit.element;
      if (e.type !== "image" || e.isDeleted || e.customData?.yAssetHash) continue;
      const file = e.fileId ? this.files[e.fileId] : undefined;
      if (!file) throw new Error("Image bytes are missing. Keep this tab open and retry.");
      const blob = await (await fetch(file.dataURL)).blob();
      const result = await boardRequest<{ hash: string }>(`sessions/${this.session}/board/assets`, blob);
      edit.element = { ...e, customData: { ...e.customData, yAssetHash: result.hash } };
    }
    await this.persist();
    const sent = this.flight;
    const result = await boardRequest<{ revision: number }>(`sessions/${this.session}/board/edits`, sent);
    const records = { ...this.state.records };
    for (const edit of sent.edits) {
      const old = records[edit.element.id];
      records[edit.element.id] = { element: edit.element, revision: result.revision,
        creator: old?.creator ?? edit.actor, editor: edit.actor, mixed: Boolean(old && (old.mixed || old.creator !== edit.actor)),
        task_region: old?.task_region ?? this.state.active_region };
    }
    this.state = { ...this.state, records, revision: result.revision, viewport: sent.viewport };
    this.flight = null;
    await this.persist();
    this.status("Board saved");
  }

  async startTask(taskId: string): Promise<void> {
    await this.flush();
    const regionId = crypto.randomUUID();
    await boardRequest<Region>(`sessions/${this.session}/board/regions`, { region_id: regionId, task_id: taskId, expected_revision: this.state.revision });
    const remote = await boardRequest<BoardState>(`sessions/${this.session}/board`);
    this.state = remote;
    // System-generated elements are introduced through restoration, not counted as human edits.
    this.ready = false; await this.restore(); this.ready = true;
    await this.persist();
    const region = remote.regions.find(r => r.region_id === regionId)!;
    const outline = this.api.getSceneElements().find(e => e.id === `region-${region.region_id}`);
    if (outline) this.api.scrollToContent(outline, { fitToViewport: true, viewportZoomFactor: .8 });
  }

  /** Save the board and build a context request with crops. `capture: false` leaves freezing the source to the caller's endpoint. */
  async prepare(assistance: Assistance = { self_reported_help: false, solution_revealed: false }, teaching = false, capture = true): Promise<{ request: ContextRequest; packet: Packet }> {
    await this.flush();
    const request: ContextRequest = { request_id: crypto.randomUUID(), revision: this.state.revision,
      region_id: this.state.active_region, selection: teaching ? Object.keys(this.api.getAppState().selectedElementIds) : [],
      viewport: viewport(this.api.getAppState()), crops: [], assistance };
    const preview = await boardRequest<Packet>(`sessions/${this.session}/board/context`, request);
    const visual = preview.focused.filter(f => f.visual);
    if (visual.length && !preview.coverage.omitted) {
      const elements = this.api.getSceneElements();
      const groups = visual.length > 1 ? [visual.slice(0, Math.ceil(visual.length / 2)), visual.slice(Math.ceil(visual.length / 2))] : [visual];
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      for (const group of groups) {
        if (!group.length) continue;
        const minX = Math.min(...group.map(f => f.bounds.x)), minY = Math.min(...group.map(f => f.bounds.y));
        const maxX = Math.max(...group.map(f => f.bounds.x + f.bounds.w)), maxY = Math.max(...group.map(f => f.bounds.y + f.bounds.h));
        // Don't make tiny mathematical marks illegible by shrinking a huge region into one image.
        if (maxX - minX > 3000 || maxY - minY > 3000) continue;
        const ids = new Set(group.map(f => f.id));
        for (const purpose of ["initial", "detail"] as const) {
          const included = new Set(ids);
          if (purpose === "detail") {
            // Re-read with neighboring labels/geometry, rather than asking the same question of identical pixels.
            for (const f of preview.focused) {
              if (!f.visual && f.bounds.x <= maxX + 120 && f.bounds.x + f.bounds.w >= minX - 120 &&
                  f.bounds.y <= maxY + 120 && f.bounds.y + f.bounds.h >= minY - 120 && f.bounds.w < 1200 && f.bounds.h < 1200) included.add(f.id);
            }
          }
          const subset = preview.focused.filter(f => included.has(f.id));
          const left = Math.min(...subset.map(f => f.bounds.x)), top = Math.min(...subset.map(f => f.bounds.y));
          const right = Math.max(...subset.map(f => f.bounds.x + f.bounds.w)), bottom = Math.max(...subset.map(f => f.bounds.y + f.bounds.h));
          const blob = await exportToBlob({ elements: elements.filter(e => included.has(e.id)), files: this.api.getFiles(),
            appState: { exportBackground: true, viewBackgroundColor: "#ffffff" }, exportPadding: 24,
            getDimensions: (w: number, h: number) => {
              const scale = Math.min(purpose === "initial" ? 2 : 4, 1600 / w, 1600 / h, Math.sqrt(1_999_000 / (w * h)));
              return { width: Math.floor(w * scale), height: Math.floor(h * scale), scale };
            } });
          if (!blob) continue;
          const asset = await boardRequest<{ hash: string }>(`sessions/${this.session}/board/assets`, blob);
          request.crops.push({ asset_hash: asset.hash, element_ids: [...ids],
            bounds: { x: left - 24, y: top - 24, w: right - left + 48, h: bottom - top + 48 }, purpose });
        }
      }
    }
    if (!capture) return { request, packet: preview };
    const attempt = await boardRequest<{ packet: Packet }>(`sessions/${this.session}/board/attempts`, request);
    return { request, packet: attempt.packet };
  }

  validSource(source: Packet["source"]): boolean {
    const current = new Map(this.api.getSceneElementsIncludingDeleted().map(e => [e.id, e]));
    return Object.entries(source.element_revisions).every(([id, revision]) => {
      const saved = this.state.records[id], e = current.get(id);
      return saved?.revision === revision && e && elementStamp(e) === elementStamp(saved.element);
    });
  }

  validateOutput(elements: readonly ExcalidrawElement[]) {
    if (!this.generationSource || !this.generationArea) return;
    if (!this.validSource(this.generationSource)) throw new Error("Your question changed; ask again with the updated board.");
    const area = this.generationArea;
    for (const e of elements) {
      // A pointing ring belongs on the learner's work, outside the response area; it never covers ink (no fill).
      if (isPointElement(e) && [e.x, e.y, e.width, e.height].every(Number.isFinite)) continue;
      if (![e.x, e.y, e.width, e.height].every(Number.isFinite) || e.x < area.x || e.y < area.y ||
          e.x + Math.abs(e.width) > area.x + area.w || e.y + Math.abs(e.height) > area.y + area.h) throw new Error("The tutor response exceeded its drawing area. Completed work is saved.");
    }
  }

  async exportRecovery() {
    await this.persist();
    const blob = new Blob([JSON.stringify({ type: "excalidraw", version: 2, source: "Y recovery", elements: this.api.getSceneElementsIncludingDeleted(), files: this.api.getFiles() })], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "y-board-recovery.excalidraw"; link.click(); URL.revokeObjectURL(url);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.debounce); clearTimeout(this.maximum); clearTimeout(this.durable);
    if (this.ready) void this.persist().catch(() => {});
  }
}
