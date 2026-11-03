// "Classic tools": the earlier demo surfaces (Teach me, Practice, samples, legacy chat), off the board by default
// and switched on in Settings. One stored flag, shared by every component through a window event.
import { useSyncExternalStore } from "react";

const KEY = "y_classic_tools_v1";
const EVENT = "y-classic-tools";

const read = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  return () => window.removeEventListener(EVENT, notify);
};

export function setClassicTools(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(EVENT));
}

export function useClassicTools(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
