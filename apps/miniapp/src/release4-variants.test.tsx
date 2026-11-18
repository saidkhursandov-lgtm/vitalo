import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { VariantChips } from './components/Variants';
import { I18nProvider } from './lib/i18n';
import type { Lang, ProductVariant } from './lib/types';

const V: ProductVariant[] = [
  { id: 'a', label_ru: '60 капсул', label_uz: '60 kapsula', price_uzs: 301000, in_stock: true, current: true },
  { id: 'b', label_ru: '120 капсул', label_uz: '120 kapsula', price_uzs: 509000, in_stock: false, current: false },
];
const show = (lang: Lang, v?: ProductVariant[]) =>
  render(
    <MemoryRouter>
      <I18nProvider lang={lang} setLang={() => undefined}>
        <VariantChips variants={v} />
      </I18nProvider>
    </MemoryRouter>,
  );
afterEach(cleanup);

describe('D-79 «Фасовка» в карточке товара', () => {
  it('кнопки фасовок с ценой; текущая отмечена; другая ведёт на свой товар; нет в наличии — без цены', () => {
    show('ru', V);
    expect(screen.getByRole('heading', { name: 'Фасовка' })).toBeTruthy();
    const [cur, other] = screen.getAllByRole('listitem');
    expect(cur.getAttribute('aria-current')).toBe('true');
    expect(cur.textContent).toMatch(/60 капсул.*301\s000/);
    expect(other.getAttribute('href')).toBe('/product/b');
    expect(other.textContent).toBe('120 капсулнет в наличии');
  });

  it('по-узбекски — узбекские подписи; без фасовок блока нет', () => {
    show('uz', V);
    expect(screen.getByRole('heading', { name: 'Qadoq' })).toBeTruthy();
    expect(screen.getByText('120 kapsula')).toBeTruthy();
    cleanup();
    expect(show('ru', []).container.innerHTML).toBe('');
  });
});
