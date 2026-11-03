// One anonymous identity per page. A fresh browser has no cookie, so parallel first calls would each mint a
// different identity and later requests would carry the wrong one (401/404). Every first call awaits this.
export interface Identity { ready?: boolean; persona?: string | null }

let identity: Promise<Identity> | null = null;

export function ensureIdentity(): Promise<Identity> {
  if (!identity) identity = (async () => {
    const response = await fetch("/api/learning/identity", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error(`identity ${response.status}`);
    return response.json() as Promise<Identity>;
  })().catch(error => { identity = null; throw error; });
  return identity;
}

/** Tests only: forget the cached identity. */
export function resetIdentity(): void { identity = null; }
