import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Label, type LabelData } from './pages/Labels';
import { maskDate } from './pages/Receiving';

afterEach(cleanup);

const DATA: LabelData = {
  physical_id: 'V-000184',
  sku: 'VTL-OMEGA3',
  composition_ru: 'Рыбий жир, желатин',
  composition_uz: 'Baliq yog‘i, jelatin',
  expiry_date: '2027-12-31',
};

describe('label 75×120 (stage 2B)', () => {
  it('has Physical ID, its barcode, SKU, composition RU/UZ and the expiry date ДД.ММ.ГГГГ', () => {
    render(<Label data={DATA} />);
    const text = screen.getByTestId('label').textContent ?? '';
    for (const part of ['V-000184', 'SKU: VTL-OMEGA3', 'Состав: Рыбий жир, желатин', 'Tarkibi: Baliq yog‘i, jelatin', 'Срок годности / Yaroqlilik muddati:', '31.12.2027']) {
      expect(text).toContain(part);
    }
    const svg = screen.getByRole('img', { name: 'Штрихкод V-000184' });
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(20);
    expect(svg.getAttribute('style')).toMatch(/width: [\d.]+mm/);
  });

  it('never prints the product name or order numbers, even if they come along', () => {
    const extra = { ...DATA, name_ru: 'Омега-3 Тестовая', order_number: 'VT-000123' } as LabelData;
    render(<Label data={extra} />);
    const text = screen.getByTestId('label').textContent ?? '';
    expect(text).not.toContain('Омега-3 Тестовая');
    expect(text).not.toContain('VT-000123');
  });

  it('empty composition: a dash, the label still prints', () => {
    render(<Label data={{ ...DATA, composition_ru: null, composition_uz: '' }} />);
    const text = screen.getByTestId('label').textContent ?? '';
    expect(text).toContain('Состав: —');
    expect(text).toContain('Tarkibi: —');
  });
});

describe('expiry date field', () => {
  it('types as ДД.ММ.ГГГГ', () => {
    expect(maskDate('31122027')).toBe('31.12.2027');
    expect(maskDate('3112')).toBe('31.12');
    expect(maskDate('31.12.2027')).toBe('31.12.2027');
    expect(maskDate('31/12/20279')).toBe('31.12.2027');
  });
});
