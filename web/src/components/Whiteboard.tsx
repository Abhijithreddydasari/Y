"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";

const Excalidraw = dynamic(
  async () => (await import("@excalidraw/excalidraw")).Excalidraw,
  { ssr: false },
);

// Dynamic export scale. The model's vision encoder downsamples to a fixed
// resolution, so what matters is pixels-per-content, not a fixed multiplier.
// We size the export so the content's bounding box lands near a target
// resolution: a tiny handwritten problem gets scaled up (its integral limits,
// exponents and subscripts stay legible), while a large sprawling canvas is
// scaled less so the payload stays sane. Both edges are pushed to a minimum
// so thin, wide content (e.g. a single-line integral) still renders tall
// enough to read.
const EXPORT_TARGET_LONG_EDGE = 1600;
const EXPORT_TARGET_SHORT_EDGE = 1000;
const EXPORT_MIN_SCALE = 1;
const EXPORT_MAX_SCALE = 4;
const EXPORT_MAX_PIXELS = 6_000_000;

function computeExportScale(elements: readonly ExcalidrawElement[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    if (el.isDeleted) continue;
    const w = (el as { width?: number }).width ?? 0;
    const h = (el as { height?: number }).height ?? 0;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + w);
    maxY = Math.max(maxY, el.y + h);
  }
  if (!Number.isFinite(minX)) return 2; // empty canvas: any scale is fine
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  // Whichever axis needs more magnification to clear its minimum wins.
  let scale = Math.max(
    EXPORT_TARGET_LONG_EDGE / longEdge,
    EXPORT_TARGET_SHORT_EDGE / shortEdge,
  );
  scale = Math.min(scale, EXPORT_MAX_SCALE);
  // Never blow past the pixel budget when scaling small content way up.
  const pixelCapScale = Math.sqrt(EXPORT_MAX_PIXELS / (width * height));
  scale = Math.min(scale, pixelCapScale);
  return Math.max(EXPORT_MIN_SCALE, Math.min(EXPORT_MAX_SCALE, scale));
}

export interface WhiteboardHandle {
  exportPng: () => Promise<Blob | null>;
  appendElements: (els: readonly ExcalidrawElement[]) => void;
  /**
   * Patch a single existing element in place. Used by the lesson player to
   * progressively reveal a text element word-by-word in lockstep with TTS.
   * No-ops if no element with the given id is on the canvas.
   */
  mutateElement: (id: string, patch: Record<string, unknown>) => void;
  addFiles: (files: BinaryFiles) => void;
  clearAll: () => void;
  getElements: () => readonly ExcalidrawElement[];
  /** Pan only when the newest tutor element would otherwise be off-screen. */
  ensureElementVisible: (id: string) => void;
  /** Fit the completed tutor answer, rather than leaving later steps off-canvas. */
  fitElements: (ids: readonly string[]) => void;
  /**
   * Compute the on-screen (viewport) rect for a scene element. Used by the
   * stroke-by-stroke draw animation to position an overlay SVG exactly on
   * top of the image element while it animates. Returns null if the element
   * can't be found or the canvas isn't mounted.
   */
  getElementScreenRect: (id: string) => DOMRect | null;
}

interface Props {
  onReady?: (handle: WhiteboardHandle) => void;
}

export default function Whiteboard({ onReady }: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  const buildHandle = useCallback((): WhiteboardHandle => ({
    async exportPng() {
      const api = apiRef.current;
      if (!api) return null;
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      // The exported canvas is `content-bbox * exportScale`. Pick the scale
      // dynamically from how much the student actually drew so the model always
      // receives a consistently-detailed image (small marks like a definite
      // integral's limits survive) without an oversized payload.
      const blob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportBackground: true,
          exportScale: computeExportScale(elements),
        },
        files,
        mimeType: "image/png",
      });
      return blob;
    },
    appendElements(els) {
      const api = apiRef.current;
      if (!api) return;
      const current = api.getSceneElements();
      api.updateScene({ elements: [...current, ...els] });
    },
    mutateElement(id, patch) {
      const api = apiRef.current;
      if (!api) return;
      const current = api.getSceneElements();
      let touched = false;
      const next = current.map((el) => {
        if (el.id !== id) return el;
        touched = true;
        return {
          ...el,
          ...patch,
          version: (el.version ?? 0) + 1,
          versionNonce: Math.floor(Math.random() * 0x7fffffff),
          updated: Date.now(),
        } as typeof el;
      });
      if (!touched) return;
      api.updateScene({ elements: next });
    },
    addFiles(files) {
      const api = apiRef.current;
      if (!api) return;
      api.addFiles(Object.values(files));
    },
    clearAll() {
      const api = apiRef.current;
      if (!api) return;
      api.updateScene({ elements: [] });
    },
    getElements() {
      const api = apiRef.current;
      return api ? api.getSceneElements() : [];
    },
    ensureElementVisible(id) {
      const api = apiRef.current;
      const container = containerRef.current;
      if (!api || !container) return;
      const el = api.getSceneElements().find((candidate) => candidate.id === id);
      if (!el) return;
      const appState = api.getAppState();
      const bounds = container.getBoundingClientRect();
      const zoom = appState.zoom?.value ?? 1;
      const left = (el.x + (appState.scrollX ?? 0)) * zoom + bounds.left;
      const top = (el.y + (appState.scrollY ?? 0)) * zoom + bounds.top;
      const right = left + el.width * zoom;
      const bottom = top + el.height * zoom;
      const safe = {
        left: bounds.left + 28,
        top: bounds.top + 92,
        right: bounds.right - 28,
        bottom: bounds.bottom - 52,
      };
      if (left < safe.left || right > safe.right || top < safe.top || bottom > safe.bottom) {
        api.scrollToContent(el, {
          animate: true,
          duration: 180,
          minZoom: 0.45,
          maxZoom: 1,
        });
      }
    },
    fitElements(ids) {
      const api = apiRef.current;
      if (!api || ids.length === 0) return;
      const wanted = new Set(ids);
      const elements = api.getSceneElements().filter((el) => wanted.has(el.id));
      if (!elements.length) return;
      api.scrollToContent(elements, {
        fitToViewport: true,
        viewportZoomFactor: 0.78,
        animate: true,
        duration: 320,
        minZoom: 0.32,
        maxZoom: 1,
      });
    },
    getElementScreenRect(id) {
      const api = apiRef.current;
      const container = containerRef.current;
      if (!api || !container) return null;
      const el = api.getSceneElements().find((e) => e.id === id);
      if (!el) return null;
      const appState = api.getAppState();
      const containerRect = container.getBoundingClientRect();
      const z = appState.zoom?.value ?? 1;
      const sx = appState.scrollX ?? 0;
      const sy = appState.scrollY ?? 0;
      // Excalidraw scene -> viewport: (scene_xy + scroll) * zoom + container offset.
      const x = (el.x + sx) * z + containerRect.left;
      const y = (el.y + sy) * z + containerRect.top;
      const w = el.width * z;
      const h = el.height * z;
      return new DOMRect(x, y, w, h);
    },
  }), []);

  useEffect(() => {
    if (ready && apiRef.current && onReady) {
      onReady(buildHandle());
    }
  }, [ready, onReady, buildHandle]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          setReady(true);
        }}
        initialData={{
          appState: {
            viewBackgroundColor: "#fafafa",
            currentItemStrokeColor: "#111111",
          },
        }}
      />
    </div>
  );
}
