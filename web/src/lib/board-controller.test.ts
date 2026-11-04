import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { BoardController, stackingOrder } from "./board-controller";
import { BoardError, type BoardState } from "./board-api";
import { performance as clock } from "node:perf_hooks";

const mocks = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("./board-api", async original => ({ ...await original<typeof import("./board-api")>(), boardSession: async () => "session", boardRequest: mocks.request }));
vi.mock("./board-outbox", () => ({ readDraft: mocks.read, writeDraft: mocks.write }));
vi.mock("@excalidraw/excalidraw", () => ({ restoreElements: (elements: unknown) => elements }));

const e = (text = "4", version = 1) => ({ id: "answer", type: "text", text, originalText: text, x: 1, y: 2, width: 100, height: 20, version, versionNonce: version, isDeleted: false } as ExcalidrawElement);
const empty = (): BoardState => ({ revision: 0, records: {}, viewport: null, regions: [], active_region: null });
let controllers: BoardController[] = [];
function harness(remote = empty()) {
  let elements: readonly ExcalidrawElement[] = [];
  const appState = { width: 1000, height: 700, scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } as AppState;
  const api = { getSceneElementsIncludingDeleted: () => elements, getSceneElements: () => elements.filter(e => !e.isDeleted), getFiles: () => ({}), getAppState: () => appState,
    addFiles: vi.fn(), updateScene: ({ elements: next }: { elements: readonly ExcalidrawElement[] }) => { elements = next; } } as unknown as ExcalidrawImperativeAPI;
  mocks.request.mockImplementation(async (path, body) => path.endsWith("/board") ? remote : { revision: body.expected_revision + 1 });
  const status = vi.fn(), board = new BoardController(api, status); controllers.push(board);
  const draw = (next: ExcalidrawElement) => { elements = [next]; board.observe(elements, appState, {}); };
  return { board, api, status, draw };
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.read.mockResolvedValue(undefined); mocks.write.mockResolvedValue(undefined); });
afterEach(() => { controllers.forEach(c => c.dispose()); controllers = []; vi.useRealTimers(); });

describe("stackingOrder", () => {
  it("restores the saved stack with each label right after its box, whatever the ids", () => {
    const order = stackingOrder([
      { id: "5J5-label", index: "a9", containerId: "y-box" },
      { id: "a-on-top", index: "b5" },
      { id: "y-box", index: "b1" },
      { id: "z-below", index: "a0" },
      { id: "no-index", index: null },
      { id: "orphan-label", index: "a5", containerId: "gone" },
    ]).map(e => e.id);
    expect(order).toEqual(["no-index", "z-below", "orphan-label", "y-box", "5J5-label", "a-on-top"]);
  });
});

describe("board recovery and attribution", () => {
  it("debounces edits, performs no inference, and submits the latest version", async () => {
    const h = harness(); await h.board.initialize();
    h.draw(e("4", 1)); await vi.advanceTimersByTimeAsync(300); h.draw(e("40", 2));
    expect(mocks.request.mock.calls.filter(([path]) => path.endsWith("/edits"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(750);
    const edits = mocks.request.mock.calls.filter(([path]) => path.endsWith("/edits"));
    expect(edits).toHaveLength(1); expect(edits[0][1].edits[0].element.text).toBe("40");
    expect(mocks.request.mock.calls.some(([path]) => /assess|teach|context/.test(path))).toBe(false);
  });

  it("flushes during continuous drawing by the maximum delay", async () => {
    const h = harness(); await h.board.initialize();
    for (let i = 1; i <= 10; i++) { h.draw(e(String(i), i)); await vi.advanceTimersByTimeAsync(500); }
    expect(mocks.request.mock.calls.some(([path]) => path.endsWith("/edits"))).toBe(true);
  });

  it("retains an operation across a lost acknowledgement and retries the same ID", async () => {
    const h = harness(); await h.board.initialize(); h.draw(e());
    mocks.request.mockRejectedValueOnce(new Error("lost response"));
    await expect(h.board.flush()).rejects.toThrow("lost response");
    const first = mocks.request.mock.calls.at(-1)![1];
    await h.board.flush();
    const second = mocks.request.mock.calls.at(-1)![1];
    expect(first.operation_id).toBe(second.operation_id);
    expect(h.board.state.revision).toBe(1);
  });

  it("restores an interrupted outbox and retries its original operation", async () => {
    const flight = { operation_id: "pending-op", expected_revision: 0, edits: [{ element: e(), actor: "human" }], viewport: { x: 0, y: 0, w: 500, h: 500 } };
    mocks.read.mockResolvedValue({ base: empty(), pending: [], flight, files: {} });
    const h = harness(); await h.board.initialize();
    expect(h.api.getSceneElements()[0].id).toBe("answer");
    expect(mocks.request.mock.calls.find(([path]) => path.endsWith("/edits"))![1].operation_id).toBe("pending-op");
  });

  it("preserves local work on revision conflict and stops further writes", async () => {
    const h = harness(); await h.board.initialize(); h.draw(e());
    mocks.request.mockRejectedValueOnce(new BoardError(409, "board_revision_conflict"));
    await expect(h.board.flush()).rejects.toThrow();
    expect(h.board.conflict).toBe(true);
    expect(mocks.write.mock.calls.at(-1)![1].flight.edits[0].element.text).toBe("4");
    const count = mocks.request.mock.calls.length;
    await expect(h.board.flush()).rejects.toThrow("newer board revision");
    expect(mocks.request.mock.calls).toHaveLength(count);
  });

  it("retains model origin and marks a later human replacement as mixed", async () => {
    const h = harness(); await h.board.initialize();
    h.board.mutate("model", () => h.api.updateScene({ elements: [e()] }), 0);
    await h.board.flush();
    expect(h.board.state.records.answer.creator).toBe("model");
    h.draw(e("5", 2)); await h.board.flush();
    expect(h.board.state.records.answer.mixed).toBe(true);
    expect(h.board.state.records.answer.editor).toBe("human");
  });

  it("marks imported elements unknown and detects stale source before output", async () => {
    const h = harness(); await h.board.initialize(); h.board.markImport(); h.draw(e()); await h.board.flush();
    expect(h.board.state.records.answer.creator).toBe("unknown");
    const source = { session_id: "session", revision: 1, element_revisions: { answer: 1 }, content_hash: "hash", crop_hashes: [] };
    expect(h.board.validSource(source)).toBe(true);
    h.draw(e("changed", 2)); expect(h.board.validSource(source)).toBe(false);
  });

  it.each([500, 5000])("tracks one changed element on a %i-element board without serializing all edits", async count => {
    const remote = empty();
    for (let i = 0; i < count; i++) {
      const element = { ...e(), id: `e${i}` } as ExcalidrawElement;
      remote.records[element.id] = { element, revision: 0, creator: "human", editor: "human", mixed: false, task_region: null };
    }
    const h = harness(remote); await h.board.initialize();
    const elements = h.api.getSceneElementsIncludingDeleted().map((element, i) => i === 0 ? { ...element, version: 2 } : element);
    h.api.updateScene({ elements });
    const start = clock.now();
    h.board.observe(elements, h.api.getAppState(), {});
    console.info(`board_observe elements=${count} ms=${(clock.now() - start).toFixed(2)}`);
    await h.board.flush();
    expect(mocks.request.mock.calls.find(([path]) => path.endsWith("/edits"))![1].edits).toHaveLength(1);
  });
});
