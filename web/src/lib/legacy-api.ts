/** The legacy service (health, chat, learner) exists only locally unless a deployment names it. */
export const legacyApiConfigured = (env: Record<string, string | undefined> = {
  NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
}): boolean => env.NODE_ENV !== "production" || Boolean(env.NEXT_PUBLIC_API_BASE);
