import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { BonusTeaser } from './components/BonusTeaser';
import { TrustTiles } from './components/HomeBlocks';
import { I18nProvider } from './lib/i18n';
import type { Lang, ShopInfo } from './lib/types';

const shop: ShopInfo = {
  product_disclaimer: { ru: 'БАД', uz: 'BFQ' },
  support_contact: '@VITALO_support',
  support_url: 'https://t.me/VITALO_support',
  payment_check_hours: { from: '08:00', to: '22:00' },
  delivery_days_label: { ru: 'рабочих дней', uz: 'ish kuni' },
  delivery_terms: { tashkent: { min_days: 2, max_days: 5 }, regions: { min_days: 5, max_days: 10 } },
  bonus_teaser: { enabled: true, text: { ru: 'Скоро: копите бонусы за покупки', uz: 'Tez orada: bonus to‘plang' } },
  home_content: {
    banner: { enabled: true, title: { ru: 'T', uz: 'T' }, subtitle: { ru: 'S', uz: 'S' }, button: { ru: 'Смотреть каталог', uz: 'Katalog' } },
    trust: [
      { key: 'original', enabled: true, title: { ru: 'Оригинальная продукция', uz: 'Original' }, text: { ru: '', uz: '' } },
      { key: 'delivery', enabled: true, title: { ru: 'Доставка по всему Узбекистану', uz: 'Yetkazib berish' }, text: { ru: '{delivery}', uz: '{delivery}' } },
      { key: 'documents', enabled: false, title: { ru: 'Документы', uz: 'Hujjatlar' }, text: { ru: '', uz: '' } },
      { key: 'payments', enabled: true, title: { ru: 'Подтверждаем платежи ежедневно {from}-{to}', uz: 'To‘lovlar {from}-{to}' }, text: { ru: '', uz: '' } },
    ],
    steps: { enabled: true, items: [] },
  },
};

afterEach(cleanup);

function wrap(lang: Lang, ui: React.ReactNode) {
  const client = new QueryClient();
  client.setQueryData(['shop-texts'], shop);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          {ui}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VITALO Bonus card (B4)', () => {
  it('shows "Скоро" without any balance or numbers; opens how it will work', () => {
    const { container } = wrap('ru', <BonusTeaser />);
    expect(container.textContent).toContain('Бонусный кошелёк');
    expect(container.textContent).toContain('Накопительный баланс');
    expect(container.textContent).toContain('Скоро');
    expect(container.textContent).not.toMatch(/\d|сум/);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').textContent).toContain('Запуск скоро, мы сообщим в Telegram');
  });

  it('hidden when switched off in the admin panel', () => {
    const client = new QueryClient();
    client.setQueryData(['shop-texts'], { ...shop, bonus_teaser: { ...shop.bonus_teaser!, enabled: false } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <I18nProvider lang="ru" setLang={() => undefined}>
          <BonusTeaser />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('Home trust tiles (B1)', () => {
  it('only switched-on tiles; delivery terms and payment hours filled in', () => {
    const { container } = wrap('ru', <TrustTiles shop={shop} />);
    expect(container.querySelectorAll('.trust-tile')).toHaveLength(3);
    expect(container.textContent).toContain('г. Ташкент — 2–5 рабочих дней, регионы — 5–10 рабочих дней');
    expect(container.textContent).toContain('Подтверждаем платежи ежедневно 08:00-22:00');
    expect(container.querySelectorAll('.trust-tile svg')).toHaveLength(3);
  });
});
