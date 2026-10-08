import { printTicketKey, PrintTicketPayload, signPrintTicket, verifyPrintTicket } from './print-ticket';

describe('print ticket', () => {
  const key = printTicketKey('test-bot-token');
  const now = Date.UTC(2026, 9, 8, 12);
  const base: PrintTicketPayload = { v: 1, ss: 'staff-session-1', exp: now / 1000 + 900, session_id: 'receiving-1' };

  it('round-trips the scope, the staff session and the expiry', () => {
    expect(verifyPrintTicket(key, signPrintTicket(key, base), now)).toEqual(base);
    const units = { ...base, session_id: undefined, unit_ids: ['u1'] };
    expect(verifyPrintTicket(key, signPrintTicket(key, units), now)).toMatchObject({ unit_ids: ['u1'] });
  });

  it('expires', () => {
    expect(() => verifyPrintTicket(key, signPrintTicket(key, base), now + 900_000)).toThrow('expired');
  });

  it('rejects another key, a changed payload or a changed signature', () => {
    const t = signPrintTicket(key, base);
    expect(() => verifyPrintTicket(printTicketKey('other-token'), t, now)).toThrow('bad signature');
    const [, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...base, session_id: 'receiving-2' })).toString('base64url');
    expect(() => verifyPrintTicket(key, `${forged}.${sig}`, now)).toThrow('bad signature');
    expect(() => verifyPrintTicket(key, `${t.split('.')[0]}.AAAA`, now)).toThrow('bad signature');
  });

  it('rejects garbage and a ticket without exactly one scope', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', 'x.']) expect(() => verifyPrintTicket(key, bad, now)).toThrow();
    expect(() => verifyPrintTicket(key, signPrintTicket(key, { ...base, session_id: undefined }), now)).toThrow('malformed');
    expect(() => verifyPrintTicket(key, signPrintTicket(key, { ...base, unit_ids: ['u1'] }), now)).toThrow('malformed');
  });

  it('the signing key is not the bot token itself', () => {
    expect(key.toString('utf8')).not.toContain('test-bot-token');
  });
});
