import { renderNotification, ruDays } from '../notifications/notification-templates';
import { courseDays, courseWindow, daysLeft } from './course';

const DAY = 86_400_000;

describe('4.2 «Курс заканчивается»', () => {
  it('days of the course: jars × servings ÷ servings a day; no card data — no course', () => {
    expect(courseDays(1, 60, 2)).toBe(30);
    expect(courseDays(2, 60, 1)).toBe(120);
    expect(courseDays(1, 90, 4)).toBe(22);
    expect(courseDays(1, null, 2)).toBeNull();
    expect(courseDays(1, 60, null)).toBeNull();
    expect(courseDays(1, 60, 0)).toBeNull();
  });

  it('the reminder window: 5 days before the end until the end; a short course gets none', () => {
    const delivered = new Date('2026-11-01T10:00:00Z');
    const w = courseWindow(delivered, 30)!;
    expect(w.end.getTime() - delivered.getTime()).toBe(30 * DAY);
    expect(w.end.getTime() - w.from.getTime()).toBe(5 * DAY);
    expect(courseWindow(delivered, 9)).toBeNull();
    expect(courseWindow(delivered, null)).toBeNull();
    expect(daysLeft(w.end, w.from)).toBe(5);
    expect(daysLeft(w.end, new Date(w.end.getTime() - 1000))).toBe(1);
  });

  it('the message in the customer’s language', () => {
    expect(renderNotification('course.ending', { order_number: '1', lang: 'ru', product: 'Магний B6', days: 5 })).toContain('Курс «Магний B6» заканчивается примерно через 5 дней');
    expect(renderNotification('course.ending', { order_number: '1', lang: 'ru', product: 'D3', days: 2 })).toContain('через 2 дня');
    expect(renderNotification('course.ending', { order_number: '1', lang: 'uz', product: 'D3', days: 4 })).toContain('«D3» kursi taxminan 4 kundan keyin tugaydi');
    expect([1, 2, 5, 11, 21, 22].map(ruDays)).toEqual(['день', 'дня', 'дней', 'дней', 'день', 'дня']);
  });
});
