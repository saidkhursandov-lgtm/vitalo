import type { Lang, LocalizedText } from './types';
import { telegram } from './telegram';

/** "2–5 рабочих дней" / "2–5 ish kuni"; null when the term is not set. */
export function daysText(min: number | null | undefined, max: number | null | undefined, label: LocalizedText | undefined, lang: Lang): string | null {
  if (min == null || max == null) return null;
  const word = label ? (lang === 'uz' ? label.uz : label.ru) : lang === 'uz' ? 'ish kuni' : 'рабочих дней';
  return `${min === max ? min : `${min}–${max}`} ${word}`;
}

/** Minutes since midnight in Tashkent (UTC+5, no daylight saving). */
export function tashkentMinutes(now: Date = new Date()): number {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60) % (24 * 60);
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** When the manager will check a payment reported now: within the hours, later today, or tomorrow. */
export function paymentCheckWhen(hours: { from: string; to: string }, now: Date = new Date()): 'now' | 'today' | 'tomorrow' {
  const t = tashkentMinutes(now);
  if (t < toMinutes(hours.from)) return 'today';
  if (t >= toMinutes(hours.to)) return 'tomorrow';
  return 'now';
}

/** «Оплатить»: Payme has its own screen, a transfer the card / requisites screen. */
export const payPath = (orderId: string, method: string | null | undefined) => `/orders/${orderId}/${method === 'payme' ? 'payme' : 'pay'}`;

/** Opens the support chat inside Telegram (or a new tab in a browser). */
export function openSupport(url: string | null | undefined) {
  if (!url) return;
  const app = telegram() as unknown as { openTelegramLink?: (u: string) => void } | null;
  if (app?.openTelegramLink) app.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
