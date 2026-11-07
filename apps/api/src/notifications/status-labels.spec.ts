import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATUS_LABELS } from './notification-templates';

/**
 * D-53: an order status has the same words in the admin, the Mini App, the bot and the bot messages (RU and UZ).
 * The four apps keep their own dictionaries, so this test reads them and compares the texts (emoji aside).
 */
const apps = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(apps, p), 'utf8');
const clean = (s: string) => s.replace(/^[^\p{L}]+/u, '').trim();

/** `'status.paid': 'Оплачен'` → value of the n-th occurrence (0 = RU block, 1 = UZ block). */
function dictValue(src: string, key: string, n: number): string | undefined {
  const re = new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`, 'g');
  const all = [...src.matchAll(re)].map((m) => clean(m[1]));
  return all[n];
}

const miniapp = read('miniapp/src/lib/i18n.tsx');
const bot = read('bot/src/texts.ts');
const admin = read('admin/src/lib/format.ts');
const adminLabel = (status: string) => clean(new RegExp(`^  ${status}: '([^']*)'`, 'm').exec(admin)?.[1] ?? '');

// status in the base (or the shown state) → key in the bot messages, Mini App / bot key, admin
const SAME = [
  ['awaiting_payment', 'awaiting_payment', 'awaiting_payment'],
  ['paid', 'paid', 'paid'],
  ['picking', 'picking', 'picking'],
  ['handed_to_delivery', 'handed_to_delivery', 'handed_to_delivery'],
  ['in_transit', 'in_transit', 'in_transit'],
  ['delivered', 'delivered', 'delivered'],
  ['cancelled', 'cancelled', 'cancelled'],
  ['return', 'return', 'return'],
  ['new', 'codWaiting', 'new'], // a new order waits for the manager: cash on delivery (a card order is «new» only for a moment)
  ['confirmed', 'codConfirmed', null], // cash on delivery confirmed — admin: orderStatusLabel()
] as const;

describe('order status words are the same everywhere (D-53)', () => {
  it.each(SAME)('%s', (notif, appKey, adminKey) => {
    const ru = clean(STATUS_LABELS.ru[notif]);
    const uz = clean(STATUS_LABELS.uz[notif]);
    expect(dictValue(miniapp, `status.${appKey}`, 0)).toBe(ru);
    expect(dictValue(miniapp, `status.${appKey}`, 1)).toBe(uz);
    expect(dictValue(bot, `status.${appKey}`, 0)).toBe(ru);
    expect(dictValue(bot, `status.${appKey}`, 1)).toBe(uz);
    if (adminKey) expect(adminLabel(adminKey)).toBe(ru);
    else expect(admin).toContain(`return '${ru}'`);
  });
});
