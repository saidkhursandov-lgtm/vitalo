import { INTAKE_FOOTER, openButtonText, renderCentre, renderNotification } from './notification-templates';

describe('notification texts', () => {
  it('customer messages use the same status names as the order screen, in the user language', () => {
    expect(renderNotification('order.paid', { order_number: 'VTL-20261003-0001', lang: 'ru' })).toBe('Заказ №VTL-20261003-0001: оплата подтверждена. Скоро начнём сборку.');
    expect(renderNotification('order.handed_to_delivery', { order_number: 'VTL-1', lang: 'ru' })).toBe('Заказ №VTL-1: 🚚 Передан курьеру');
    expect(renderNotification('order.in_transit', { order_number: 'VTL-1', lang: 'uz' })).toBe('№VTL-1 buyurtma: 🚚 Yo‘lda');
    expect(renderNotification('order.delivered', { order_number: 'VTL-1', lang: 'ru' })).toBe('Заказ №VTL-1: ✅ Доставлен\nСпасибо, что выбрали VITALO!');
  });

  it('defaults to Russian and adds the cancel reason when present', () => {
    expect(renderNotification('order.cancelled', { order_number: 'VTL-1' })).toBe('Заказ №VTL-1: ⚪ Отменён');
    expect(renderNotification('order.cancelled', { order_number: 'VTL-1', reason: 'Не оплачен вовремя', lang: 'uz' })).toBe(
      '№VTL-1 buyurtma: ⚪ Bekor qilindi\nSabab: Не оплачен вовремя',
    );
  });

  it('automatic cancellation shows a localized reason, not the internal one', () => {
    expect(renderNotification('order.cancelled', { order_number: 'VTL-1', reason: '@expired', lang: 'ru' })).toBe(
      'Заказ №VTL-1: ⚪ Отменён\nПричина: заказ не был оплачен вовремя',
    );
    expect(renderNotification('order.cancelled', { order_number: 'VTL-1', reason: '@expired', lang: 'uz' })).toContain('to‘lanmadi');
  });

  it('staff messages show amount, customer and phone', () => {
    expect(
      renderNotification('staff.new_order', { order_number: 'VTL-7', total_uzs: 310000, customer: 'Тест Витало', phone: '+998901234567', lang: 'ru' }),
    ).toBe('🆕 Новый заказ VTL-7 на 310 000 сум\nКлиент: Тест Витало, +998901234567');
    expect(renderNotification('staff.customer_paid', { order_number: 'VTL-7', total_uzs: 5000, lang: 'ru' })).toContain('на 5 000 сум');
  });

  it('3.6: the new-order message says there is a point on the map (the link is the button); none without a point', () => {
    const p = { order_number: 'VTL-7', total_uzs: 310000, customer: 'Тест', phone: '+998901234567', lang: 'ru' as const };
    expect(renderNotification('staff.new_order', { ...p, map_url: 'https://yandex.uz/maps/?pt=69.2856,41.3401&z=17&l=map' })).toBe(
      '🆕 Новый заказ VTL-7 на 310 000 сум\nКлиент: Тест, +998901234567\n📍 Точка на карте: кнопка «Открыть в Яндекс Картах» ниже',
    );
    expect(renderNotification('staff.new_order', p)).not.toContain('📍');
  });

  it('3.5: the new-order message carries the customer comment with its line breaks (RU / UZ)', () => {
    const comment = 'Позвоните за час.\nДомофон 25, 3 этаж';
    expect(renderNotification('staff.new_order', { order_number: 'VTL-7', total_uzs: 310000, customer: 'Тест', phone: '+998901234567', comment, lang: 'ru' })).toBe(
      '🆕 Новый заказ VTL-7 на 310 000 сум\nКлиент: Тест, +998901234567\n💬 Комментарий клиента:\nПозвоните за час.\nДомофон 25, 3 этаж',
    );
    expect(renderNotification('staff.new_order', { order_number: 'VTL-7', total_uzs: 310000, comment: 'Qo‘ng‘iroq qiling', lang: 'uz' })).toContain('\n💬 Mijoz izohi:\nQo‘ng‘iroq qiling');
    // no comment, or only spaces — no line at all
    expect(renderNotification('staff.new_order', { order_number: 'VTL-7', total_uzs: 1, comment: '  ', lang: 'ru' })).not.toContain('Комментарий');
  });

  it('every template has RU and UZ', () => {
    for (const t of ['order.paid', 'order.handed_to_delivery', 'order.in_transit', 'order.delivered', 'order.cancelled', 'staff.new_order', 'staff.customer_paid']) {
      expect(renderNotification(t, { order_number: 'X', lang: 'ru' })).toContain('X');
      expect(renderNotification(t, { order_number: 'X', lang: 'uz' })).toContain('X');
    }
  });

  it('unknown templates are an error, not a silent empty message', () => {
    expect(() => renderNotification('order.nope', { order_number: 'X' })).toThrow(/Unknown notification template/);
  });

  it('3.2: new order messages, picking, intake guide and the centre lines (no emoji)', () => {
    expect(renderNotification('order.accepted_pay', { order_number: 'VTL-2', total_uzs: 145000, until: '31.10.2026, 18:20', lang: 'ru' })).toBe(
      'Заказ №VTL-2 принят. Ожидает оплаты: 145 000 сум до 31.10.2026, 18:20. После перевода отправьте чек.',
    );
    expect(renderNotification('order.accepted_cod', { order_number: 'VTL-3', lang: 'uz' })).toContain('menejer ish vaqtida (08:00–22:00)');
    expect(renderNotification('order.picking', { order_number: 'VTL-4', lang: 'ru' })).toBe('Заказ №VTL-4 собирается. Сообщим, когда передадим в доставку.');
    const guide = renderNotification('order.intake_guide', { order_number: 'VTL-5', lang: 'ru', guide: [{ name: 'Магний B6', text: 'По 1 таблетке вечером' }] });
    expect(guide).toBe('Как принимать ваш заказ №VTL-5\n\nМагний B6\nПо 1 таблетке вечером\n\nСверяйте с этикеткой. Если принимаете лекарства — уточните у специалиста.');
    const long = renderNotification('order.intake_guide', { order_number: 'VTL-6', lang: 'uz', guide: Array.from({ length: 20 }, (_, i) => ({ name: 'P' + i, text: 'x'.repeat(400) })) });
    expect(long.length).toBeLessThan(4096);
    expect(long.endsWith(INTAKE_FOOTER.uz)).toBe(true);
    expect(renderCentre('order.handed_to_delivery', { order_number: 'VTL-1' }, 'ru')).toEqual({ title: 'Заказ №VTL-1', body: 'Передан курьеру' });
    expect(renderCentre('waitlist.back_in_stock', { order_number: '', product: 'Омега-3' }, 'uz')).toEqual({ title: 'Омега-3', body: 'Yana sotuvda' });
    expect(renderCentre('promo.message', { order_number: '', title_ru: 'Скидка', text_ru: 'До пятницы' }, 'uz')).toEqual({ title: 'Скидка', body: 'До пятницы' });
    expect(openButtonText('pay', 'uz')).toBe('To‘lash / Chek yuborish');
  });
});
