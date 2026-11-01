import { DEFAULT_TEMPLATES, answerIn, mergeTemplates, setKeyOf, tashkentDayStart } from './compat';
import { compatButtons } from '../notifications/notification-worker';

describe('3.4 compatibility rules', () => {
  it('the same products in any order and with repeats give one key', () => {
    expect(setKeyOf(['b', 'a', 'c'])).toBe('a,b,c');
    expect(setKeyOf(['c', 'b', 'a', 'a'])).toBe(setKeyOf(['a', 'b', 'c']));
    expect(setKeyOf(['a', 'b'])).not.toBe(setKeyOf(['a', 'b', 'c']));
  });

  it('the day of the limit starts at 00:00 Tashkent time', () => {
    // 2026-11-01 19:30 UTC = 2026-11-02 00:30 Tashkent
    expect(tashkentDayStart(new Date('2026-11-01T19:30:00Z')).toISOString()).toBe('2026-11-01T19:00:00.000Z');
    // 2026-11-01 18:59 UTC = 23:59 Tashkent of the 1st
    expect(tashkentDayStart(new Date('2026-11-01T18:59:00Z')).toISOString()).toBe('2026-10-31T19:00:00.000Z');
  });

  it('saved templates fall back to the defaults for empty texts', () => {
    const t = mergeTemplates({ compatible: { ru: '  Своё  ', uz: '' }, junk: 1 });
    expect(t.compatible.ru).toBe('Своё');
    expect(t.compatible.uz).toBe(DEFAULT_TEMPLATES.compatible.uz);
    expect(t.consult).toEqual(DEFAULT_TEMPLATES.consult);
    expect(mergeTemplates(null)).toEqual(DEFAULT_TEMPLATES);
  });

  it('a template answer follows the customer language; an own text stays', () => {
    const t = mergeTemplates({ spread: { ru: 'Новый RU', uz: 'Yangi UZ' } });
    expect(answerIn(DEFAULT_TEMPLATES.compatible.ru, 'compatible', 'ru', 'uz', t)).toBe(DEFAULT_TEMPLATES.compatible.uz);
    expect(answerIn('Новый RU', 'spread', 'ru', 'uz', t)).toBe('Yangi UZ');
    expect(answerIn(DEFAULT_TEMPLATES.spread.ru, 'spread', 'ru', 'uz', t)).toBe(DEFAULT_TEMPLATES.spread.uz);
    expect(answerIn('Магний вечером', 'consult', 'ru', 'uz', t)).toBe('Магний вечером');
    expect(answerIn('Любой', 'consult', 'uz', 'uz', t)).toBe('Любой');
  });

  it('bot buttons fit Telegram callback data (64 bytes)', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    for (const b of compatButtons(id).flat()) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
  });
});
