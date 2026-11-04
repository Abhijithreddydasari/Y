/** The legacy service (health, chat, learner) is called only when a deployment or a developer names it. */
export const legacyApiConfigured = (env: Record<string, string | undefined> = {
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
}): boolean => Boolean(env.NEXT_PUBLIC_API_BASE);
