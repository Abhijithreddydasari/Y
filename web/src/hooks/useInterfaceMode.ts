"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { INTERFACE_STORAGE_KEY, resolveInterfaceMode, type InterfaceMode } from "@/lib/interface-mode";

export function useInterfaceMode() {
  const [mode, setModeState] = useState<InterfaceMode>("studio");
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("ui");
    const stored = window.localStorage.getItem(INTERFACE_STORAGE_KEY);
    const hasOverride = query === "mobile" || query === "studio" || stored === "mobile" || stored === "studio";
    manualRef.current = hasOverride;
    const frame = window.requestAnimationFrame(() => {
      setManual(hasOverride);
      setModeState(resolveInterfaceMode({ query, stored, width: window.innerWidth }));
    });
    const onResize = () => {
      if (!manualRef.current) setModeState(resolveInterfaceMode({ width: window.innerWidth }));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const setMode = useCallback((next: InterfaceMode) => {
    setModeState(next);
    setManual(true);
    manualRef.current = true;
    window.localStorage.setItem(INTERFACE_STORAGE_KEY, next);
    const url = new URL(window.location.href);
    url.searchParams.set("ui", next);
    window.history.replaceState({}, "", url);
  }, []);

  const useAutomaticMode = useCallback(() => {
    window.localStorage.removeItem(INTERFACE_STORAGE_KEY);
    const url = new URL(window.location.href);
    url.searchParams.delete("ui");
    window.history.replaceState({}, "", url);
    setManual(false);
    manualRef.current = false;
    setModeState(resolveInterfaceMode({ width: window.innerWidth }));
  }, []);

  return { mode, manual, setMode, useAutomaticMode };
}
