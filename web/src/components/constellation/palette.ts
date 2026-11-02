// Map colours for the night canvas and the papyrus (light) canvas. Meaning never rests on colour alone:
// dendrite length, labels and the sheet say it too. Light-mode colours are darker so they hold contrast on beige.
import type { NodeState } from "@/lib/learner-contracts";
import { SHAKY_BELOW, SOLID_AT } from "./map-model";

export type MindTheme = "dark" | "light";
export const THEME_KEY = "y_mind_theme";

export interface Palette {
  theme: MindTheme; bg: string; shaky: string; learning: string; solid: string; unseen: string; unseenSoma: string;
  misconception: string; resolved: string; synapse: string; misfire: string; spike: string; path: string;
  cortex: string; stub: string; selected: string; label: string;
  /** Additive light on the night canvas; plain alpha on paper (additive vanishes on a light background). */
  additive: boolean; glow: number; cortexGain: number;
}

export const PALETTES: Record<MindTheme, Palette> = {
  dark: {
    theme: "dark", bg: "#0B0E14", shaky: "#F0997B", learning: "#AFA9EC", solid: "#5DCAA5", unseen: "#888780", unseenSoma: "#2C2C2A",
    misconception: "#E24B4A", resolved: "#FAC775", synapse: "#7F77DD", misfire: "#E24B4A", spike: "#EEEDFE", path: "#FAC775",
    cortex: "#9A9890", stub: "#5F5E5A", selected: "#FFFFFF", label: "#E8E6DF", additive: true, glow: 0.5, cortexGain: 0.62,
  },
  light: {
    theme: "light", bg: "#F7F1E3", shaky: "#C9542A", learning: "#5B52C0", solid: "#13805F", unseen: "#8C8577", unseenSoma: "#ECE4D2",
    misconception: "#C23634", resolved: "#B07210", synapse: "#6259C8", misfire: "#C23634", spike: "#3C3489", path: "#B07210",
    cortex: "#7D7360", stub: "#B9AF9A", selected: "#2C2C2A", label: "#2C2C2A", additive: false, glow: 0.26, cortexGain: 0.9,
  },
};

export const valueColor = (mean: number, p: Palette = PALETTES.dark) => (mean < SHAKY_BELOW ? p.shaky : mean < SOLID_AT ? p.learning : p.solid);
export function stateColor(state: NodeState, p: Palette = PALETTES.dark): string {
  switch (state) {
    case "solid": return p.solid;
    case "learning": return p.learning;
    case "shaky": case "misconception": return p.shaky;
    default: return p.unseen;
  }
}
export const STATE_WORDS: Record<NodeState, string> = {
  solid: "Solid", learning: "Learning", shaky: "Shaky", misconception: "Misconception active", unseen: "Not practised yet",
};

/** Overlay chrome as CSS variables on the dialog root. */
export const CHROME: Record<MindTheme, Record<string, string>> = {
  dark: {
    "--mind-bg": "#0B0E14", "--mind-glass": "rgba(22,26,36,.76)", "--mind-line": "rgba(255,255,255,.13)", "--mind-text": "#ECEAE3",
    "--mind-text-2": "#D3D1C7", "--mind-muted": "#A3A199", "--mind-faint": "#7C7A73", "--mind-track": "rgba(255,255,255,.1)",
    "--mind-bad-bg": "rgba(226,75,74,.16)", "--mind-bad": "#F7C1C1", "--mind-good-bg": "rgba(250,199,117,.12)", "--mind-good": "#FAC775",
    "--mind-link": "#C4BFF3", "--mind-misfire": "#F09595", "--mind-accent": "#AFA9EC",
  },
  light: {
    "--mind-bg": "#F7F1E3", "--mind-glass": "rgba(255,251,242,.8)", "--mind-line": "rgba(74,58,30,.16)", "--mind-text": "#2A2621",
    "--mind-text-2": "#3D3830", "--mind-muted": "#6B6355", "--mind-faint": "#8A8172", "--mind-track": "rgba(74,58,30,.12)",
    "--mind-bad-bg": "rgba(194,54,52,.1)", "--mind-bad": "#8E2422", "--mind-good-bg": "rgba(176,114,16,.12)", "--mind-good": "#7A4F0A",
    "--mind-link": "#4A41A8", "--mind-misfire": "#A32D2D", "--mind-accent": "#5B52C0",
  },
};
