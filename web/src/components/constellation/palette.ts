// Map colours on the dark canvas. Meaning never rests on colour alone: dendrite length, labels and the sheet say it too.
import type { NodeState } from "@/lib/learner-contracts";
import { SHAKY_BELOW, SOLID_AT } from "./map-model";

export const SHAKY = "#F0997B";
export const LEARNING = "#AFA9EC";
export const SOLID = "#5DCAA5";
export const UNSEEN = "#888780";
export const MISCONCEPTION = "#E24B4A";
export const RESOLVED = "#FAC775";

export const valueColor = (mean: number) => (mean < SHAKY_BELOW ? SHAKY : mean < SOLID_AT ? LEARNING : SOLID);
export function stateColor(state: NodeState): string {
  switch (state) {
    case "solid": return SOLID;
    case "learning": return LEARNING;
    case "shaky": return SHAKY;
    case "misconception": return SHAKY;
    default: return UNSEEN;
  }
}
export const STATE_WORDS: Record<NodeState, string> = {
  solid: "Solid", learning: "Learning", shaky: "Shaky", misconception: "Misconception active", unseen: "Not practised yet",
};
