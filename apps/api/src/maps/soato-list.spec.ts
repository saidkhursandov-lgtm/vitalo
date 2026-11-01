import { readFileSync } from 'fs';
import { join } from 'path';

/** The SOATO list (Agency of statistics) written into the database by the migration: complete and clean. */
const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261107100000_soato_districts/migration.sql'), 'utf8');
const rows = [...sql.matchAll(/^ {2}\('(\d{7})', '(\d{4})', '([^']+)', '((?:[^']|'')+)', (NULL|'[^']+')\)/gm)].map((m) => ({ code: m[1], region: m[2], ru: m[3], uz: m[4] }));

describe('SOATO districts and cities', () => {
  it('207 units of 14 regions, every code once, the code starts with its region', () => {
    expect(rows).toHaveLength(207);
    expect(new Set(rows.map((r) => r.code)).size).toBe(207);
    expect(new Set(rows.map((r) => r.region)).size).toBe(14);
    expect(rows.every((r) => r.code.startsWith(r.region))).toBe(true);
  });

  it('names: no Latin letters in Russian, no Cyrillic in Uzbek, no «Город» / «shahri» leftovers', () => {
    expect(rows.filter((r) => /[a-z]/i.test(r.ru)).map((r) => r.ru)).toEqual([]);
    expect(rows.filter((r) => /[а-яё]/i.test(r.uz)).map((r) => r.uz)).toEqual([]);
    expect(rows.filter((r) => /^Город|shahri|shahar/.test(r.ru + ' ' + r.uz))).toEqual([]);
  });

  it('the districts the map could not find before are there', () => {
    const ru = rows.map((r) => r.ru);
    for (const name of ['Ташкентский район', 'Кибрайский район', 'Зангиатинский район', 'Бостанлыкский район', 'Асакинский район']) expect(ru).toContain(name);
  });

  it('only adds: no DROP, DELETE or renames; towns are hidden, not removed', () => {
    expect(sql).not.toMatch(/\bDELETE\b|DROP COLUMN|DROP INDEX|RENAME|SET "name_/i);
    expect(sql.match(/^ {2}\('[^']+', '\d{7}'\)/gm)).toHaveLength(27);
  });
});
