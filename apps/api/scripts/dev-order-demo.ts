/**
 * Walks the whole order flow against the running dev API and prints each step in plain Russian:
 * login -> cart -> delivery -> order -> bank details -> "Я оплатил" -> manager confirms -> stock check.
 * Usage: npm run start:dev (in one terminal), then npm run dev:order-demo
 */
import { randomUUID } from 'crypto';
import { API, DEV_CUSTOMER, DEV_MANAGER, devInitData } from './dev-login';

const fmt = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} сум`;

async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token && { authorization: `Bearer ${opts.token}` }),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  console.log('\n1) Покупатель входит через Telegram');
  const { token } = await call('POST', '/auth/telegram', { body: { initData: devInitData(DEV_CUSTOMER) } });
  console.log('   ✔ вход выполнен');

  console.log('\n2) Кладём в корзину 2 × «Омега-3» и 1 × «Магний B6»');
  const products = await call('GET', '/catalog/products?brand=NordOcean,SunVita&in_stock=true');
  const omega = products.items.find((p: any) => p.sku === 'VTL-OMEGA3');
  const magnesium = products.items.find((p: any) => p.sku === 'VTL-MG-B6');
  for (const id of (await call('GET', '/cart', { token })).items.map((i: any) => i.product_id)) {
    await call('DELETE', `/cart/items/${id}`, { token }); // start from an empty cart
  }
  await call('POST', '/cart/items', { token, body: { product_id: omega.id, qty: 2 } });
  await call('POST', '/cart/items', { token, body: { product_id: magnesium.id, qty: 1 } });

  const regions = await call('GET', '/delivery/regions');
  const tashkent = regions.find((r: any) => r.name_ru === 'г. Ташкент');
  const city = tashkent.cities[0];
  const cart = await call('GET', `/cart?region_id=${tashkent.id}&city_id=${city.id}`, { token });
  console.log(`   товары: ${fmt(cart.goods_total_uzs)}; доставка (${tashkent.name_ru}, ${city.name_ru}): ${fmt(cart.delivery.cost_uzs)}`);
  console.log(`   подсказка: «${cart.delivery.message_ru}»`);

  const stockBefore = await call('GET', `/catalog/products/${omega.id}`);
  console.log(`\n3) Оформляем заказ (сервер сам считает цены и резервирует товар). Омега-3 в наличии: ${stockBefore.in_stock ? 'да' : 'нет'}`);
  const checkout = {
    source: 'cart',
    recipient_name: 'Тест Витало',
    recipient_phone: '90 123 45 67',
    region_id: tashkent.id,
    city_id: city.id,
    address_text: 'ул. Амира Темура, 1',
    payment_method: 'bank_transfer',
  };
  const preview = await call('POST', '/orders/preview', { token, body: checkout });
  const key = randomUUID();
  const order = await call('POST', '/orders', {
    token,
    headers: { 'idempotency-key': key },
    body: { ...checkout, expected_total_uzs: preview.totals.total_uzs },
  });
  console.log(`   ✔ заказ ${order.order_number}, статус: ${order.status}, к оплате: ${fmt(order.totals.total_uzs)}`);
  console.log(`   резерв до: ${new Date(order.reserved_until).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })} (Ташкент)`);

  const repeat = await call('POST', '/orders', {
    token,
    headers: { 'idempotency-key': key },
    body: { ...checkout, expected_total_uzs: preview.totals.total_uzs },
  });
  console.log(`   повторная отправка той же формы вернула тот же заказ: ${repeat.order_number === order.order_number ? 'да ✔' : 'НЕТ ✘'}`);

  console.log('\n4) Реквизиты для банковского перевода');
  const bank = await call('GET', `/orders/${order.id}/payment/bank-transfer`, { token });
  console.log(`   получатель: ${bank.requisites.recipient}; счёт: ${bank.requisites.account}`);
  console.log(`   сумма: ${fmt(bank.amount_uzs)}; назначение: «${bank.purpose}»`);

  console.log('\n5) Покупатель нажимает «Я оплатил»');
  await call('POST', `/orders/${order.id}/payment/bank-transfer/paid`, { token, body: {} });
  console.log('   ✔ заказ ждёт подтверждения менеджера');

  console.log('\n6) Менеджер входит и подтверждает оплату');
  const staff = await call('POST', '/staff/auth/telegram', { body: { initData: devInitData(DEV_MANAGER) } });
  const waiting = await call('GET', '/staff/orders?awaiting_confirmation=true', { token: staff.token });
  console.log(`   в списке «ждут подтверждения»: ${waiting.items.some((o: any) => o.id === order.id) ? 'да ✔' : 'нет ✘'}`);
  const paid = await call('POST', `/staff/orders/${order.id}/confirm-payment`, { token: staff.token, body: { comment: 'Демо' } });
  console.log(`   ✔ статус: ${paid.status}, оплата: ${paid.payment_status}`);

  console.log('\n7) История статусов заказа');
  for (const h of paid.history) {
    const at = new Date(h.created_at).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tashkent' });
    console.log(`   ${at}  ${h.from_status ?? '—'} → ${h.to_status}  (${h.changed_by_type}: ${h.reason ?? ''})`);
  }
  console.log('\nГотово. Этот же заказ можно посмотреть в Swagger: GET /api/orders/{id} с токеном покупателя.');
  console.log(`id заказа: ${order.id}\n`);
}

main().catch((e) => {
  console.error(e instanceof TypeError ? `API is not reachable (is npm run start:dev running?): ${e.message}` : e.message);
  process.exitCode = 1;
});
