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
