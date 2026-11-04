// Two-finger pinch on the pen tool, on a stylus device. Once Excalidraw sees a stylus it turns on pen mode, which keeps
// fingers from drawing but also fixes the zoom scale at 1 while the freedraw tool is active, so a pinch only pans.
// Pen mode is lifted only while two fingers are down, so palm rejection holds the rest of the time.
interface PinchApi {
  getAppState(): { penMode: boolean; activeTool: { type: string } };
  updateScene(scene: { appState: { penMode: boolean } }): void;
}

export function installPenPinch(api: PinchApi, area: HTMLElement): () => void {
  const fingers = new Set<number>();
  let stylusDown = false, lifted = false;

  const down = (event: PointerEvent) => {
    if (event.pointerType === "pen") { stylusDown = true; return; }
    if (event.pointerType !== "touch" || !area.contains(event.target as Node)) return;
    fingers.add(event.pointerId);
    if (fingers.size < 2 || lifted || stylusDown) return;
    const state = api.getAppState();
    if (state.penMode && state.activeTool.type === "freedraw") {
      lifted = true;
      api.updateScene({ appState: { penMode: false } });
    }
  };
  const up = (event: PointerEvent) => {
    if (event.pointerType === "pen") { stylusDown = false; return; }
    fingers.delete(event.pointerId);
    if (lifted && fingers.size < 2) {
      lifted = false;
      api.updateScene({ appState: { penMode: true } });
    }
  };

  // Capture: this has to run before Excalidraw handles the same event.
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    if (lifted) api.updateScene({ appState: { penMode: true } });
  };
}
