import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Label, Label75x120, PrintLabels, QrCode, TestPrint, type LabelData } from './pages/Labels';
import { maskDate } from './pages/Receiving';

afterEach(cleanup);

const DATA: LabelData = {
  physical_id: 'V-000184',
  sku: 'OZN-A001',
  expiry_date: '2027-12-31',
};

describe('Physical ID label 58×40', () => {
  it('has Physical ID, SKU, the expiry date ДД.ММ.ГГГГ and a QR code; 58×40 mm by default', () => {
    render(<Label data={DATA} />);
    const label = screen.getByTestId('label');
    const text = label.textContent ?? '';
    for (const part of ['V-000184', 'OZN-A001', '31.12.2027']) expect(text).toContain(part);
    expect(label.style.width).toBe('58mm');
    expect(label.style.height).toBe('40mm');
    expect(screen.getByRole('img', { name: 'QR V-000184' })).toBeTruthy();
  });

  it('never prints the product name, composition, order numbers, price or cost, even if they come along', () => {
    const extra = { ...DATA, name_ru: 'Омега-3 Тестовая', composition_ru: 'Рыбий жир', order_number: 'VT-000123', price_uzs: 99_000, actual_cost_uzs: 12_345 } as LabelData;
    render(<Label data={extra} />);
    const text = screen.getByTestId('label').textContent ?? '';
    for (const leak of ['Омега-3 Тестовая', 'Рыбий жир', 'Состав', 'VT-000123', '99000', '99 000', '12345', '12 345']) expect(text).not.toContain(leak);
  });

  it('takes the paper size from the setting', () => {
    render(<Label data={DATA} size={{ width_mm: 70, height_mm: 50 }} />);
    const label = screen.getByTestId('label');
    expect(label.style.width).toBe('70mm');
    expect(label.style.height).toBe('50mm');
  });

  it('QR holds only the Physical ID: version 1 (21×21 modules) with the finder patterns', () => {
    render(<QrCode value="V-000184" sizeMm={22} />);
    const svg = screen.getByRole('img', { name: 'QR V-000184' });
    expect(svg.getAttribute('data-modules')).toBe('21');
    expect(svg.getAttribute('style')).toContain('22mm');
    const d = svg.querySelector('path')!.getAttribute('d')!;
    // top-left finder pattern starts at the quiet zone (2 modules): its corner module is dark
    expect(d.startsWith('M2 2h1v1h-1z')).toBe(true);
  });
});

describe('print pages', () => {
  it('/print/test: 3 sample labels 58×40, @page 58mm 40mm without margins, no sign-in needed', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/print/test']}>
        <TestPrint />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId('label')).toHaveLength(3);
    expect(container.querySelector('style')?.textContent).toBe('@page { size: 58mm 40mm; margin: 0; }');
  });

  it('/print/labels without a ticket: asks to open printing from the admin panel and calls no API', () => {
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (() => {
      called = true;
      return new Promise(() => undefined);
    }) as typeof fetch;
    try {
      render(
        <MemoryRouter initialEntries={['/print/labels']}>
          <PrintLabels />
        </MemoryRouter>,
      );
      expect(screen.getByText(/Откройте печать из админки/)).toBeTruthy();
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('75×120 template (kept, not used)', () => {
  it('still renders Physical ID, its barcode, SKU, composition RU/UZ and the expiry date', () => {
    render(<Label75x120 data={{ ...DATA, composition_ru: 'Рыбий жир, желатин', composition_uz: null }} />);
    const text = screen.getByTestId('label-75x120').textContent ?? '';
    for (const part of ['V-000184', 'SKU: OZN-A001', 'Состав: Рыбий жир, желатин', 'Tarkibi: —', '31.12.2027']) expect(text).toContain(part);
    expect(screen.getByRole('img', { name: 'Штрихкод V-000184' }).querySelectorAll('rect').length).toBeGreaterThan(20);
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
