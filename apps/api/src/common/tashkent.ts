/** Asia/Tashkent is UTC+5 all year (no DST). DB stores UTC; business dates use Tashkent time. */
const TASHKENT_UTC_OFFSET_MS = 5 * 3600_000;

/** Calendar date in Tashkent as YYYY-MM-DD. */
export function tashkentDateString(at: Date): string {
  return new Date(at.getTime() + TASHKENT_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** 1234567 -> "1 234 567" (UZS amounts in user-facing messages). */
export function formatUzs(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** "04.10.2026, 14:15" in Tashkent time (messages to customers). */
export function tashkentDateTime(at: Date): string {
  const t = new Date(at.getTime() + TASHKENT_UTC_OFFSET_MS).toISOString();
  return `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}, ${t.slice(11, 16)}`;
}
