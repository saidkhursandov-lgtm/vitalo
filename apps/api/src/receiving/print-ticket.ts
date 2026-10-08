import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Print ticket: lets the label page open in a normal browser (Chrome) without Telegram and without the staff token.
 *
 * The signed-in employee asks for a ticket in the admin panel; the ticket only allows printing the labels of ONE
 * receiving session (or a few units), lives TICKET_TTL_SECONDS and is tied to the employee's staff session: logout,
 * block or an expired session make it useless at once. Stateless (HMAC), so no table and no migration. The admin
 * panel puts it into the URL fragment (#t=…), which browsers do not send to servers or in the Referer.
 */
export const TICKET_TTL_SECONDS = 15 * 60;
/** A ticket for single units is meant for reprinting one label; a whole receiving goes by session id. */
export const TICKET_MAX_UNITS = 50;

export interface PrintScope {
  session_id?: string;
  unit_ids?: string[];
}

export interface PrintTicketPayload extends PrintScope {
  v: 1;
  /** staff_sessions.id of the employee who asked for the ticket. */
  ss: string;
  /** Expiry, unix seconds. */
  exp: number;
}

export class PrintTicketError extends Error {}

/** The signing key is derived from a server secret, so it never equals the secret itself. */
export const printTicketKey = (secret: string) => createHmac('sha256', 'VITALO print ticket v1').update(secret).digest();

const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest();

export function signPrintTicket(key: Buffer, payload: PrintTicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(key, body).toString('base64url')}`;
}

/** Checks signature, shape and expiry; the staff session itself is checked by the caller. */
export function verifyPrintTicket(key: Buffer, ticket: string, now = Date.now()): PrintTicketPayload {
  const [body, sig, extra] = ticket.split('.');
  if (!body || !sig || extra !== undefined) throw new PrintTicketError('malformed');
  const expected = mac(key, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new PrintTicketError('bad signature');
  let p: PrintTicketPayload;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new PrintTicketError('malformed');
  }
  if (p?.v !== 1 || typeof p.ss !== 'string' || typeof p.exp !== 'number') throw new PrintTicketError('malformed');
  if (!p.session_id === !p.unit_ids?.length) throw new PrintTicketError('malformed'); // exactly one scope
  if (p.exp * 1000 <= now) throw new PrintTicketError('expired');
  return p;
}
