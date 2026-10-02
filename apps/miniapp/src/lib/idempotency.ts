/**
 * One Idempotency-Key per distinct order attempt: retrying the same form (double tap, network error)
 * reuses the key, so the API returns the already created order; changing the form gets a new key.
 */
export function createIdempotencyKeys() {
  let last: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(body: unknown): string {
      const fingerprint = JSON.stringify(body);
      if (!last || last.fingerprint !== fingerprint) last = { fingerprint, key: crypto.randomUUID() };
      return last.key;
    },
  };
}
