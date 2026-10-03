import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './components/Markdown';
import { daysText, paymentCheckWhen, tashkentMinutes } from './lib/shop';
import { dedupeHistory } from './screens/Orders';

describe('delivery term text', () => {
  const label = { ru: 'рабочих дней', uz: 'ish kuni' };
  it('range, single day, missing', () => {
    expect(daysText(2, 5, label, 'ru')).toBe('2–5 рабочих дней');
    expect(daysText(5, 10, label, 'uz')).toBe('5–10 ish kuni');
    expect(daysText(3, 3, label, 'ru')).toBe('3 рабочих дней');
    expect(daysText(null, 5, label, 'ru')).toBeNull();
  });
});

describe('payment check hours (Tashkent = UTC+5)', () => {
  const hours = { from: '08:00', to: '22:00' };
  const at = (utc: string) => new Date(`2026-10-04T${utc}:00Z`);
  it('inside the window, before it, after it', () => {
    expect(tashkentMinutes(at('05:30'))).toBe(10 * 60 + 30);
    expect(paymentCheckWhen(hours, at('05:30'))).toBe('now'); // 10:30 Tashkent
    expect(paymentCheckWhen(hours, at('01:00'))).toBe('today'); // 06:00
    expect(paymentCheckWhen(hours, at('17:30'))).toBe('tomorrow'); // 22:30
    expect(paymentCheckWhen(hours, at('20:00'))).toBe('today'); // 01:00 next day
  });
});

describe('legal text Markdown', () => {
  it('bold, lists, escapes and paragraphs; no HTML injection', () => {
    const { container } = render(<Markdown text={'**1. Общие положения**\n\n1.1. Продавец: \\[полное наименование\\] @VITALO\\_support\n\n- первый\n- второй\n\n<script>alert(1)</script>'} />);
    expect(container.querySelector('strong')?.textContent).toBe('1. Общие положения');
    expect(container.textContent).toContain('Продавец: [полное наименование] @VITALO_support');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});

describe('order history', () => {
  it('the same status twice in a row is shown once', () => {
    const h = [{ to_status: 'new' }, { to_status: 'awaiting_payment' }, { to_status: 'paid' }, { to_status: 'paid' }, { to_status: 'picking' }];
    const label = (s: string) => (s === 'new' ? 'awaiting_payment' : s);
    expect(dedupeHistory(h, label).map((x) => x.to_status)).toEqual(['new', 'paid', 'picking']);
  });
});
