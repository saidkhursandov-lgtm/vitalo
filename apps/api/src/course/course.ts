/**
 * Release 4.2 «Курс заканчивается»: how long the jars of an order last and when to remind. No database here.
 */

/** Remind this many days before the course ends. */
export const COURSE_REMIND_BEFORE_DAYS = 5;
/** A shorter course gets no reminder: «через 5 дней» right after the delivery would only be noise. */
export const COURSE_MIN_DAYS = 10;

const DAY_MS = 86_400_000;

/** Days of the course: jars × servings in a jar ÷ servings a day (whole days), or null without the card data. */
export function courseDays(jars: number, packCount: number | null, servingsPerDay: number | null): number | null {
  if (!packCount || !servingsPerDay || packCount <= 0 || servingsPerDay <= 0 || jars <= 0) return null;
  return Math.floor((jars * packCount) / servingsPerDay);
}

/**
 * The reminder window of a delivered line: from 5 days before the end until the end. Null when the course is too short
 * (or unknown) to remind about.
 */
export function courseWindow(deliveredAt: Date, days: number | null): { from: Date; end: Date } | null {
  if (days === null || days < COURSE_MIN_DAYS) return null;
  const end = new Date(deliveredAt.getTime() + days * DAY_MS);
  return { from: new Date(end.getTime() - COURSE_REMIND_BEFORE_DAYS * DAY_MS), end };
}

/** Whole days left until the end (at least 1). */
export function daysLeft(end: Date, now: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}
