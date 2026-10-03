import { renderNotification } from './notification-templates';

describe('notification texts', () => {
  it('customer messages use the same status names as the order screen, in the user language', () => {
    expect(renderNotification('order.paid', { order_number: 'VTL-20261003-0001', lang: 'ru' })).toBe(
      'Заказ №VTL-20261003-0001: 🟢 Оплачен\nНачинаем собирать ваш заказ.',
    );
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

  it('every template has RU and UZ', () => {
    for (const t of ['order.paid', 'order.handed_to_delivery', 'order.in_transit', 'order.delivered', 'order.cancelled', 'staff.new_order', 'staff.customer_paid']) {
      expect(renderNotification(t, { order_number: 'X', lang: 'ru' })).toContain('X');
      expect(renderNotification(t, { order_number: 'X', lang: 'uz' })).toContain('X');
    }
  });

  it('unknown templates are an error, not a silent empty message', () => {
    expect(() => renderNotification('order.nope', { order_number: 'X' })).toThrow(/Unknown notification template/);
  });
});
