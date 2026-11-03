// Demo personas ("Try as…"): the server keeps which persona a browser acts as; this mirrors it locally so the
// board session id is stored per profile and never sent to another profile's owner.
import { useEffect, useState } from "react";

export interface Persona { key: string; name: string; blurb: string; topics: string[]; copied: boolean }
export interface PersonaListing { active: string | null; personas: Persona[] }

const MIRROR = "y_profile_v1";

/** The persona this browser last acted as (null: your own profile). */
export function profileKey(): string | null {
  try { return localStorage.getItem(MIRROR) || null; } catch { return null; }
}

export function setProfileKey(key: string | null): void {
  try { if (key) localStorage.setItem(MIRROR, key); else localStorage.removeItem(MIRROR); } catch { /* storage blocked */ }
}

/** Board session storage key for a profile: your own keeps the original key. */
export const sessionKey = (key: string | null = profileKey()) => key ? `y_board_session_v1:${key}` : "y_board_session_v1";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/learning/${path}`, { credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) throw new Error(`personas ${response.status}`);
  return response.json() as Promise<T>;
}

/** The listing; asks for the anonymous identity first, since this can run before the board has one. */
export async function fetchPersonas(): Promise<PersonaListing> {
  await call<unknown>("identity", { method: "POST", body: "{}" });
  return call<PersonaListing>("personas");
}

/** Act as a persona (null: your own). The page reloads so every board hook starts on that profile's session. */
export async function switchProfile(key: string | null): Promise<void> {
  await call<PersonaListing>("personas/active", { method: "PUT", body: JSON.stringify({ persona: key }) });
  setProfileKey(key);
  window.location.reload();
}

/** Throw away this browser's copy of a persona and rebuild it from the template. */
export async function resetPersona(key: string): Promise<void> {
  await call<PersonaListing>(`personas/${key}/reset`, { method: "POST" });
  try { localStorage.removeItem(sessionKey(key)); } catch { /* storage blocked */ }
  window.location.reload();
}

export const firstName = (persona: Persona | undefined) => persona?.name.split(" ")[0] ?? "";

export function usePersonas(): { listing: PersonaListing | null; active: Persona | undefined; error: string } {
  const [listing, setListing] = useState<PersonaListing | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchPersonas().then(setListing).catch(() => setError("Personas are unavailable right now."));
  }, []);
  return { listing, active: listing?.personas.find((p) => p.key === listing.active), error };
}
