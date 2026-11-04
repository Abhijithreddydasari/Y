import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPenPinch } from "./pen-pinch";

function pointer(type: string, pointerId: number, pointerType: string, target: EventTarget) {
  const event = new Event(type, { bubbles: true }) as Event & { pointerId: number; pointerType: string };
  Object.assign(event, { pointerId, pointerType });
  target.dispatchEvent(event);
}

describe("installPenPinch", () => {
  let area: HTMLElement, stop: () => void;
  const state = { penMode: true, activeTool: { type: "freedraw" } };
  const updateScene = vi.fn();

  beforeEach(() => {
    area = document.body.appendChild(document.createElement("div"));
    Object.assign(state, { penMode: true, activeTool: { type: "freedraw" } });
    updateScene.mockReset();
    stop = installPenPinch({ getAppState: () => state, updateScene }, area);
  });
  afterEach(() => { stop(); area.remove(); });

  it("lifts pen mode only while two fingers are down", () => {
    pointer("pointerdown", 1, "touch", area);
    expect(updateScene).not.toHaveBeenCalled(); // one finger: palm rejection holds
    pointer("pointerdown", 2, "touch", area);
    expect(updateScene).toHaveBeenLastCalledWith({ appState: { penMode: false } });
    pointer("pointerup", 2, "touch", area);
    expect(updateScene).toHaveBeenLastCalledWith({ appState: { penMode: true } });
    expect(updateScene).toHaveBeenCalledTimes(2);
  });

  it("leaves pen mode alone without a stylus, on other tools, during a stroke and outside the board", () => {
    state.penMode = false;
    pointer("pointerdown", 1, "touch", area); pointer("pointerdown", 2, "touch", area);
    pointer("pointerup", 1, "touch", area); pointer("pointerup", 2, "touch", area);
    state.penMode = true; state.activeTool.type = "selection";
    pointer("pointerdown", 1, "touch", area); pointer("pointerdown", 2, "touch", area);
    pointer("pointerup", 1, "touch", area); pointer("pointerup", 2, "touch", area);
    state.activeTool.type = "freedraw";
    pointer("pointerdown", 9, "pen", area);
    pointer("pointerdown", 1, "touch", area); pointer("pointerdown", 2, "touch", area);
    pointer("pointerup", 1, "touch", area); pointer("pointerup", 2, "touch", area); pointer("pointerup", 9, "pen", area);
    pointer("pointerdown", 1, "touch", document.body); pointer("pointerdown", 2, "touch", document.body);
    expect(updateScene).not.toHaveBeenCalled();
  });

  it("restores pen mode if the board unmounts mid-pinch", () => {
    pointer("pointerdown", 1, "touch", area); pointer("pointerdown", 2, "touch", area);
    stop();
    expect(updateScene).toHaveBeenLastCalledWith({ appState: { penMode: true } });
    stop = () => {};
  });
});
