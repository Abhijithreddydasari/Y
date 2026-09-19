export type InterfaceMode = "mobile" | "studio";

export const INTERFACE_STORAGE_KEY = "y_interface_mode_v1";
export const STUDIO_BREAKPOINT = 700;

export function resolveInterfaceMode(options: { query?: string | null; stored?: string | null; width: number }): InterfaceMode {
  if (options.query === "mobile" || options.query === "studio") return options.query;
  if (options.stored === "mobile" || options.stored === "studio") return options.stored;
  return options.width >= STUDIO_BREAKPOINT ? "studio" : "mobile";
}
