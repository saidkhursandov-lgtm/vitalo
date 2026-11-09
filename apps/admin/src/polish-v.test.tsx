import { describe, expect, it } from 'vitest';
import { halalVegeOf, PROMO_LABELS } from './pages/ProductEdit';

/** 6а-В (D-62): Halal and Vegan / VEGE are two separate switches; the promo label list. */
describe('6а-В: Halal and Vegan switches', () => {
  it('both → halal_vege, one → halal / vege', () => {
    expect(halalVegeOf(true, true, '')).toBe('halal_vege');
    expect(halalVegeOf(true, false, 'vege')).toBe('halal');
    expect(halalVegeOf(false, true, 'halal')).toBe('vege');
  });

  it('switching VEGE off on a fish-gelatin product gives «Нет», not a hidden VEGE', () => {
    expect(halalVegeOf(false, false, 'vege')).toBe('none');
    expect(halalVegeOf(false, false, 'halal_vege')).toBe('none');
  });

  it('untouched «не заполнено» / «Не знаю» / «Нет» stay as they were', () => {
    expect(halalVegeOf(false, false, '')).toBeNull();
    expect(halalVegeOf(false, false, 'unknown')).toBe('unknown');
    expect(halalVegeOf(false, false, 'none')).toBe('none');
  });
});

describe('6а-В: promo label', () => {
  it('off, 11.11, Black Friday, Хит, Новинка — the values the server accepts', () => {
    expect(PROMO_LABELS.map(([v]) => v)).toEqual(['', 'eleven_eleven', 'black_friday', 'hit', 'new']);
    expect(PROMO_LABELS.map(([, l]) => l)).toEqual(['Выкл', '11.11', 'Black Friday', 'Хит', 'Новинка']);
  });
});
