// Tutor model and voice choices. The server owns the allowlist (GET /learning/tutor/options); the
// browser only remembers which option ids this learner picked, per device, and sends the model id
// with each turn. An option that has become unavailable falls back to the default on load.

export interface TutorOption { id: string; label: string; note: string; default: boolean; available: boolean; reason: string | null;
  effort?: string | null }
export interface TutorOptions { models: TutorOption[]; voices: TutorOption[] }
export interface TutorPrefs { model: string; voice: string }
/** Which model answered a turn, from the turn's `done` event and stored trace. */
export interface TutorTrace { option: string; model: string; effort: string | null }

export const PREFS_KEY = "y_tutor_prefs_v1";
export const KOKORO_VOICES = new Set(["kokoro_af_heart", "kokoro_am_michael"]);

export async function fetchTutorOptions(): Promise<TutorOptions | null> {
  try {
    const response = await fetch("/api/learning/tutor/options", { credentials: "same-origin", cache: "no-store" });
    return response.ok ? (await response.json() as TutorOptions) : null;
  } catch {
    return null;
  }
}

export function loadPrefs(): Partial<TutorPrefs> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}");
    return { model: typeof value.model === "string" ? value.model : undefined, voice: typeof value.voice === "string" ? value.voice : undefined };
  } catch {
    return {};
  }
}

export function savePrefs(prefs: TutorPrefs): void {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: the choice lasts this page */ }
}

function pick(list: TutorOption[], wanted: string | undefined, fallback: string): string {
  const usable = list.filter((option) => option.available);
  return usable.find((option) => option.id === wanted)?.id ?? usable.find((option) => option.default)?.id ?? usable[0]?.id ?? fallback;
}

/** Stored choices checked against what the server offers now. */
export function resolvePrefs(options: TutorOptions | null, stored: Partial<TutorPrefs>): TutorPrefs {
  if (!options) return { model: stored.model ?? "spark-1.3", voice: stored.voice ?? "kokoro_af_heart" };
  const voice = stored.voice && KOKORO_VOICES.has(stored.voice) && !options.voices.find((v) => v.id === stored.voice)?.available
    ? "browser" : stored.voice;
  return { model: pick(options.models, stored.model, "spark-1.3"), voice: pick(options.voices, voice, "browser") };
}

export function optionLabel(options: TutorOptions | null, kind: keyof TutorOptions, id: string): string {
  return options?.[kind].find((option) => option.id === id)?.label ?? id;
}
