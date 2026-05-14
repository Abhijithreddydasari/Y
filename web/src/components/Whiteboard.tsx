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
}

interface Props {
  onReady?: (handle: WhiteboardHandle) => void;
}

export default function Whiteboard({ onReady }: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [ready, setReady] = useState(false);

  const buildHandle = useCallback((): WhiteboardHandle => ({
    async exportPng() {
      const api = apiRef.current;
      if (!api) return null;
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      const blob = await exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true },
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
  }), []);

  useEffect(() => {
    if (ready && apiRef.current && onReady) {
      onReady(buildHandle());
    }
  }, [ready, onReady, buildHandle]);

  return (
    <div className="absolute inset-0">
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
