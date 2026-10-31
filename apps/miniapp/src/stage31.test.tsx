import { describe, expect, it } from 'vitest';
import { matchesPlace, rankPlaces, toLatin } from './lib/place-search';

const chilanzar = { name_ru: 'Чиланзарский район', name_uz: 'Chilonzor tumani' };
const shayx = { name_ru: 'Шайхантахурский район', name_uz: 'Shayxontohur tumani' };

describe('3.1 region / district search', () => {
  it('finds a district by part of the Russian or Uzbek name, any case', () => {
    for (const q of ['чилан', 'ЧИЛАН', 'Chilon', 'chilonzor', 'chilanzar', 'Чилонзор', '  чилан  ']) expect(matchesPlace(q, chilanzar)).toBe(true);
    expect(matchesPlace('юнус', chilanzar)).toBe(false);
  });

  it('understands Uzbek x/h and apostrophes', () => {
    expect(matchesPlace('шайхан', shayx)).toBe(true);
    expect(matchesPlace('shayhon', shayx)).toBe(true);
    expect(matchesPlace("Farg'ona", { name_ru: 'Ферганская область', name_uz: 'Fargʻona viloyati' })).toBe(true);
    expect(toLatin('Чиланзар')).toBe('chilanzar');
  });

  it('puts names that start with the query first', () => {
    const items = [{ name_ru: 'Мирзо-Улугбекский район', name_uz: null }, { name_ru: 'Улугбек', name_uz: null }];
    expect(rankPlaces(items, 'улуг', (x) => x.name_ru, 'ru').map((x) => x.name_ru)).toEqual(['Улугбек', 'Мирзо-Улугбекский район']);
  });
});
