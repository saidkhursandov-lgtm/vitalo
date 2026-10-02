import { createHash, randomBytes } from 'crypto';

/** 256-bit random token, given to the client once. Only its hash is stored (user_sessions.token_hash). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 is enough here: the token is high-entropy random, so no salt/slow hash is needed. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
