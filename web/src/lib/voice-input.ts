// Push-to-talk client: send one WAV to the API's Muse Voice Transcribe proxy and map a spoken answer onto
// a card's options. The key and the keyword hints stay server-side; nothing about the board goes in the URL.
import { BoardError } from "./board-api";

export interface Transcript { text: string; duration: number; timing?: { provider_ms: number; total_ms: number } }

const MESSAGES: Record<string, string> = {
  no_speech: "I didn't catch that. Try again, or type your question.",
  transcribe_not_configured: "Voice input is not configured on the server. Type your question instead.",
  transcribe_budget_exhausted: "The hourly voice limit is reached. Type your question instead.",
  transcribe_timeout: "Transcription took too long. Try again, or type your question.",
  audio_too_long: "That recording was too long. Keep questions under 30 seconds.",
  audio_too_large: "That recording was too long. Keep questions under 30 seconds.",
  learning_identity_required: "Your learning session expired. Reload the page to continue.",
};
const FALLBACK = "Voice input is unavailable right now. Type your question instead.";

export function voiceErrorMessage(error: unknown): string {
  if (error instanceof BoardError) return MESSAGES[error.code] ?? FALLBACK;
  return FALLBACK;
}

export async function transcribe(session: string, audio: Blob, signal?: AbortSignal): Promise<Transcript> {
  const response = await fetch(`/api/learning/sessions/${session}/transcribe`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "audio/wav" }, body: audio, signal,
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new BoardError(response.status, typeof value.detail === "string" ? value.detail : "transcribe_failed");
  }
  return response.json() as Promise<Transcript>;
}

/** Open the server's provider connection while the learner is still talking. Best effort. */
export function warmTranscription(session: string): void {
  void fetch(`/api/learning/sessions/${session}/transcribe/warm`, { method: "POST", credentials: "same-origin" }).catch(() => {});
}

const SPOKEN_LETTERS: Record<string, string> = { ay: "a", eh: "a", bee: "b", be: "b", see: "c", sea: "c", cee: "c", dee: "d", de: "d" };
const LEAD = /^(?:(?:i think|i'd say|i will go with|i'll go with|my answer is|the answer is|answer|option|letter|choice|it's|its|it is)\s+)+/;

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
const words = (text: string) => normalize(text).split(" ").filter((word) => word.length >= 3);

/**
 * The option a spoken answer names, or null when it names none or more than one. Accepts a letter
 * ("B", "option b", "I think it's C") or the option's own words.
 */
export function matchOption(spoken: string, options: string[]): string | null {
  const said = normalize(spoken);
  if (!said) return null;
  const bare = said.replace(LEAD, "").replace(/\s+(?:please|i think)$/, "");
  const letter = SPOKEN_LETTERS[bare] ?? (/^[a-z]$/.test(bare) ? bare : null)
    ?? said.match(/\b(?:option|letter|choice|answer)\s+([a-z])\b/)?.[1] ?? null;
  if (letter) {
    const index = letter.charCodeAt(0) - 97;
    return index >= 0 && index < options.length ? options[index] : null;
  }
  const exact = options.filter((option) => {
    const value = normalize(option);
    return value && (said.includes(value) || (bare.length >= 3 && value.includes(bare)));
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const heard = new Set(words(said));
  const scores = options.map((option) => {
    const terms = words(option);
    return terms.length ? terms.filter((term) => heard.has(term)).length / terms.length : 0;
  });
  const best = Math.max(...scores);
  const winners = scores.filter((score) => score > best - 0.2);
  return best >= 0.6 && winners.length === 1 ? options[scores.indexOf(best)] : null;
}
