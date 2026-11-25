# Click — подключение (SHOP API)

Разовая оплата заказа картой Uzcard / Humo на странице Click. Сделано по образцу Payme ([PAYME.md](PAYME.md)):
те же режимы показа, тот же перевод заказа в «Оплачен», те же коды ИКПУ у товаров.
Документация Click: <https://docs.click.uz> (SHOP API → Запросы / Ошибки; Платежная ссылка; Merchant API → Фискализация).

## Как это работает

1. Покупатель выбирает «Click» при оформлении. Способ виден, только когда в админке «Настройки → Оплата» у Click
   стоит «Работает» (для всех) или «Тест (сотрудники)». Включить их можно, только если все 4 ключа Click есть в `.env`.
2. Заказ создаётся «Ждёт оплаты», поверх оформления открывается «Чек VITALO» с кнопкой «Оплатить в Click».
   Для ссылок из заказа и уведомлений есть экран `/orders/:id/click`. Ссылка открывается только через адаптер
   `apps/miniapp/src/lib/telegram.ts` (`openLink`):
   `https://my.click.uz/services/pay/?service_id=…&merchant_id=…&amount=255000.00&transaction_param=202611030001&return_url=https://t.me/<бот>`
   `transaction_param` — цифры номера заказа, как у Payme: `VTL-20261103-0001` → `202611030001`.
3. Click сам вызывает наш сервер дважды (POST, form-urlencoded, ответ JSON, всегда HTTP 200):

   | Запрос | Адрес | Что делаем |
   | --- | --- | --- |
   | Prepare (`action=0`) | `https://api.vitalo.uz/api/payments/click/prepare` | проверяем подпись, заказ, сумму, коды ИКПУ; записываем транзакцию (`click_transactions`, состояние 0); отвечаем `merchant_prepare_id` |
   | Complete (`action=1`) | `https://api.vitalo.uz/api/payments/click/complete` | `error=0` — заказ «Оплачен» (состояние 1), отвечаем `merchant_confirm_id`; `error<0` — Click не списал деньги: транзакция отменена (−1), заказ ждёт дальше, отвечаем −9 |

   Запасной общий адрес `https://api.vitalo.uz/api/payments/online/click/callback` понимает оба запроса по `action`.
4. Подпись: `sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id [+ merchant_prepare_id] + amount + action + sign_time)`.
   Неверная подпись → −1, в базе ничего не меняется.
5. После оплаты экран Mini App сам обновляется (опрос каждые 4 секунды) и показывает «Оплата подтверждена».

Наши ответы (коды Click): 0 успех, −1 подпись, −2 сумма, −3 неизвестный action, −4 уже оплачен, −5 заказ не найден
(или ждёт другой способ оплаты), −6 нет транзакции (`merchant_prepare_id`), −7 у товара нет ИКПУ / внутренняя ошибка,
−8 неполный запрос или чужой `service_id`, −9 заказ отменён / время оплаты вышло / транзакция отменена.

- Повторный Prepare с тем же `click_trans_id` — тот же `merchant_prepare_id`. Повторный Complete после оплаты — −4
  (так в документации Click), заказ оплачивается один раз.
- Если покупатель или менеджер отменил заказ между Prepare и Complete — Complete получает −9 (Click возвращает деньги).
- Автоотмена по резерву ждёт до 30 минут после Prepare (пока Click не прислал Complete). Срок резерва Click
  (по умолчанию 30 минут) меняется в «Настройки → Сроки оплаты», как у Payme.
- Возврат уже оплаченного заказа: как сейчас — менеджер отменяет заказ, появляется задача «Вернуть деньги»; деньги
  возвращаются в кабинете merchant.click.uz. Автоматический возврат (Merchant API `payment/reversal`) не сделан.

## Чек (фискализация)

- Коды те же, что для Payme: блок «Чек для Payme и Click» в карточке товара (ИКПУ, код упаковки); строка «Доставка» —
  `PAYME_DELIVERY_IKPU`, `PAYME_DELIVERY_PACKAGE_CODE`; НДС — `PAYME_VAT_PERCENT` (у нас 0).
- Без кодов Click в оформлении неактивен, заказ с Click не создаётся.
- После успешного Complete сервер отправляет чек в Click: `POST https://api.click.uz/v2/merchant/payment/ofd_data/submit_items`,
  заголовок `Auth: CLICK_MERCHANT_USER_ID:sha1(timestamp + CLICK_SECRET_KEY):timestamp`. Строки: `Name`, `SPIC` (ИКПУ),
  `PackageCode`, `GoodPrice`, `Price` (вся строка), `Amount`, `Discount`, `VAT`, `VATPercent`; суммы в тийинах; вся сумма —
  `received_card`. Если Click не принял чек — `click_transactions.fiscal_status = failed`, сервер повторяет каждые 10 минут
  (до 10 раз). `CommissionInfo` с ИНН добавляется, только если заполнен `CLICK_FISCAL_TIN`.

## Настройки `.env` (значения только в `.env`, никогда в git и сообщения)

| Ключ | Откуда |
| --- | --- |
| `CLICK_SERVICE_ID` | кабинет merchant.click.uz → сервис |
| `CLICK_MERCHANT_ID` | кабинет merchant.click.uz (ID поставщика) |
| `CLICK_SECRET_KEY` | кабинет → сервис → секретный ключ. В одинарных кавычках: `CLICK_SECRET_KEY='…'` |
| `CLICK_MERCHANT_USER_ID` | кабинет → Merchant API (пользователь для запросов, нужен для чеков) |
| `CLICK_FISCAL_TIN` | необязательно: ИНН магазина, если Click скажет, что `CommissionInfo` обязателен |

## Что запросить у Click

1. Доступ в кабинет **merchant.click.uz** и созданный сервис для интернет-магазина (оплата по ссылке my.click.uz).
2. `service_id`, `merchant_id`, `secret_key` сервиса и `merchant_user_id` для Merchant API.
3. Прописать в настройках сервиса адреса:
   - Prepare: `https://api.vitalo.uz/api/payments/click/prepare`
   - Complete: `https://api.vitalo.uz/api/payments/click/complete`
4. Тестовый режим: как проверить оплату до запуска (тестовый сервис / тестовые карты / их проверка запросами).
5. Ответы на вопросы о чеке (см. текст ниже).

### Текст для специалиста Click

> Здравствуйте! Мы интернет-магазин VITALO (БАДы и витамины, Telegram Mini App). Подключаемся к Click по SHOP API
> с переходом на my.click.uz по платёжной ссылке.
>
> Адреса нашего биллинга:
> Prepare — https://api.vitalo.uz/api/payments/click/prepare
> Complete — https://api.vitalo.uz/api/payments/click/complete
>
> `merchant_trans_id` (transaction_param) — номер заказа цифрами, например 202611030001. Сумма — в сумах, формат N.NN.
>
> Просим:
> 1. Выдать service_id, merchant_id, secret_key и merchant_user_id (Merchant API — для отправки фискальных данных).
> 2. Подсказать, как провести тестовые платежи до запуска.
> 3. Уточнить по фискализации (ofd_data/submit_items):
>    - `payment_id` в submit_items — это `click_trans_id` из запросов Prepare/Complete или `click_paydoc_id`?
>    - `Price` — сумма строки до скидки (`GoodPrice × Amount`), а `Discount` вычитается из неё? Или `Price` уже со скидкой?
>    - `CommissionInfo` (ИНН) обязателен, если мы продаём свой товар, а не по комиссии? Если да — указываем ИНН магазина?
>    - Мы не плательщик НДС: передаём `VATPercent = 0`, `VAT = 0` — верно?
>    - Строка «Доставка» — отдельной позицией со своим ИКПУ — так правильно?
> 4. Подтвердить: если заказ отменён между Prepare и Complete, мы отвечаем на Complete `error = -9`. Деньги покупателю
>    Click вернёт сам, или нам нужно вызвать `payment/reversal`?
>
> Спасибо!

## Проверка перед запуском (как у Payme)

1. Ключи в `.env` на сервере, миграция `20261210100000_click_shop_api` (только добавляющая) применена через `update.sh --migrate`.
2. В админке «Настройки → Оплата»: Click → «Тест (сотрудники)». Сотрудник оформляет заказ в боевом боте и платит.
3. Проверить: заказ «Оплачен», в `click_transactions` состояние 1 и `fiscal_status = sent`, чек виден в кабинете Click.
4. Потом Click → «Работает».

## Смена способа оплаты и открытие страницы оплаты (25.11.2026)

- Экран Mini App «Оплата заказа» (`/orders/:id/payment`; старые ссылки `/payme`, `/click` открывают его же): сумма,
  срок брони, выбранный способ и кнопка «Оплатить через …». Пока заказ «Ждёт оплаты», покупатель может выбрать другой
  способ — Payme, Click, Uzum (когда подключён) или перевод на карту, только те, что сейчас открыты для него. Сумма и
  бронь не меняются. Оплата при получении здесь не предлагается. После «Я оплатил(а)» (перевод) сменить нельзя.
- API: `GET /api/payments/online/orders/:id/methods` — список; `POST /api/payments/online/orders/:id/method`
  `{ method }` — смена. Внутри блокировки заказа незавершённые транзакции всех систем отменяются: Click (состояние 0 →
  −1, поздний Complete получает −9), Payme (состояние 1 → −1, причина 3, поздний PerformTransaction получает −31008) —
  деньги система возвращает сама, заказ оплачивается один раз. Строка `payments` та же, способ меняется, попытка
  начинается заново (в `payment_attempts.provider_response_json` — с какого способа сменили). Ссылку на оплату другой
  системы сервер не выдаёт (`PAYMENT_METHOD_MISMATCH`), пока способ не сменён.
- Новая система подключается сама: модуль (OnlinePaymentGateway) реализует `abandon()` — отмену своих незавершённых транзакций.
- Ссылка оплаты открывается через адаптер `openPaymentLink` (`apps/miniapp/src/lib/telegram.ts`) — обычным `openLink` Telegram,
  без выбора браузера: тогда телефон сам открывает приложение Payme / Click. С `try_browser` (принудительно Chrome) Android
  показывал страницу в Chrome вместо приложения — проверено 25.11.2026, так не делать. Под «Ждём подтверждения» есть
  запасная кнопка «Не открылось? Скопировать ссылку на оплату».
