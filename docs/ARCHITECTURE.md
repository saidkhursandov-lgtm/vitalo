# VITALO — архитектура

Кратко и просто. Подробности выкладки — [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md), решения — [DECISIONS.md](DECISIONS.md)
и [operations/DECISIONS.md](operations/DECISIONS.md).

## Стек

| Часть | Технологии | Где код |
| --- | --- | --- |
| API | Node.js 24, NestJS 11, Prisma 6, TypeScript; фото — sharp | `apps/api` |
| База | PostgreSQL 16 (расширения `pg_trgm`, `unaccent` для поиска) | `apps/api/prisma/schema.prisma`, `migrations/` |
| Mini App | React 19, Vite 7, React Query, React Router 7; шрифт Montserrat | `apps/miniapp` |
| Админка | React 19, Vite 7, React Query | `apps/admin` |
| Бот | grammY (long polling), tsx | `apps/bot` |
| AI (3.8) | Claude API (Anthropic) через `@anthropic-ai/sdk`; модель — настройка в админке, ключ — только `ANTHROPIC_API_KEY` в `.env` | `apps/api/src/compat` |
| AI-аналитик для админа (этап 5, ветка 4) | Второй контур Claude, отдельный ключ `ANTHROPIC_ADMIN_API_KEY`, своя модель и бюджет, только администратор | `apps/api/src/ai-analyst` |
| Тесты | Jest (API, e2e на базе `vitalo_test`), Vitest (Mini App, админка, бот) | `apps/*/test`, `*.test.ts` |

## Как части связаны

```
Покупатель → Telegram → @vitalo_uz_bot ──(кнопка «Магазин»)──► Mini App (vitalo.uz)
                                │                                   │
                                │ /api/internal/bot/* (X-Bot-Secret) │ /api/* (вход по Telegram initData)
                                ▼                                   ▼
Сотрудник → admin.vitalo.uz ──────────────────────────────► API (api.vitalo.uz) ──► PostgreSQL
                                                              │  фоновые задачи: резервы, напоминания,
                                                              │  уведомления (очередь notifications), опрос Яндекса
                                                              └─► Яндекс Маркет (опрос раз в 5 мин + вебхук)
```

- Вход покупателя и сотрудника — через Telegram (initData того же бота); сотрудник должен быть в `staff_users`.
- Админка в браузере (admin.vitalo.uz, D-56; выложено на сервер 08.11, вход кнопкой в боте ждёт `/setdomain` — вопрос 111): вход кнопкой Telegram Login Widget, новый браузер подтверждается кнопкой в боте (3 минуты); сессия 30 дней в cookie HttpOnly/Secure/SameSite=Strict; изменения — только с заголовком `x-vitalo-admin`; резервные коды владельца. Telegram-вход в админку остаётся.
- Права ролей проверяет сервер (`apps/api/src/staff/permissions.ts`); меню админки только скрывает разделы.
- Уведомления пишутся в таблицу `notifications` в той же транзакции, что и изменение заказа, и отправляются ботом
  каждые 3 секунды с повторами.
- Уведомления и центр (3.2, миграция `20261102100000`, только добавляющая: 5 колонок в `notifications`, уникальный `dedup_key`): одно сообщение на каждый статус заказа, центр `/api/notifications` (вкладки «Заказы / Акции и бонусы / Сервисные»; одна карточка на заказ), `/api/orders/active` для плашки на главной. На сервере с 01.11.2026 (`fe09b28`).
- Скидки и промокоды (3.3), модуль `apps/api/src/promo`: `pricing.ts` — чистые функции расчёта скидки и бесплатной доставки (без базы); `promo.service.ts` — `PromoCodesService` (проверка кода, резерв при заказе, возврат при отмене, общий лимит через блокировку строки акции). Итог считает сервер; в заказе хранится снимок расчёта `orders.pricing_json`, он не пересчитывается. Админка — `apps/api/src/staff/admin-promo-codes.ts`. Защита маржи — настройка `promo_guard` (таблица `settings`; по умолчанию минимальная наценка 10% и скидка до 20% без закупочной цены, D-39; меняет только админ). Миграция `20261103100000` (только добавляющая); на сервере с 01.11.2026 (`65f3138`).
- Проверка совместимости у специалиста (3.4, D-40), модуль `apps/api/src/compat`: `compat.ts` — чистая логика (набор товаров без порядка и количества, лимит по Ташкенту); `compat.service.ts` — запросы, ответы, сохранённые сочетания. Маршруты: `/api/compat` (для покупателя), `/api/staff/compat/*` (очередь, ответ, сохранение сочетания, шаблоны), `/api/internal/bot/compat/:id/answer` (ответ из бота). Ежечасная задача стирает текст комментария через 90 дней (`comment_purged_at`); запрос и ответ остаются. Миграция `20261104100000` (только добавляющая); на сервере — ещё нет.
- Адрес на Яндекс Карте (3.6), модуль `apps/api/src/maps`: внешний сервис — Яндекс (JS API в браузере и геокодер с нашего сервера). Ключи только в `.env` (`YANDEX_MAPS_JS_API_KEY`, `YANDEX_GEOCODER_API_KEY`), геокодер ключ клиенту не отдаёт. Счётчики за сутки в `settings` (ключ `maps_usage`: запросы геокодера и открытия карты, по Ташкенту); ответы Яндекса не хранятся (D-42). Маршруты: `GET /api/maps/config` (без ключа), `POST /api/maps/open` (ключ JS API при открытии карты, считается), `GET /api/maps/geocode`. Миграция `20261106100000` (только добавляющая: поля квартиры, подъезда, этажа и ориентира в `addresses`); на сервере — ещё нет. Районы — полный список по классификатору СОАТО (D-43, `1fbd009`): миграция `20261107100000_soato_districts` (только добавляющая: `soato_code` у `regions` и `cities`, 166 новых районов); на `vitalo_dev` — 02.11, на сервере — ещё нет.
- VITALO AI (3.8, D-45, D-47), модуль `apps/api/src/compat`: `ai-client.ts` — единственное место, где сервер обращается к Claude API; запросы идут только с нашего сервера; без ключа, при выключенном AI или исчерпанном бюджете всё уходит специалисту. В модель уходят только данные товаров и правила, без имени, телефона и адреса.
- Лист ожидания (2.4): задача раз в минуту проверяет товары с ожидающими покупателями; при появлении остатка бот пишет каждому один раз «снова в наличии» (запись помечается `notified_at`).
- Фото товаров: на ноутбуке `apps/api/uploads/products/<id>/…`, на сервере `/var/lib/vitalo`; адрес `/uploads/...`.
- Акции и промо-скины (3.7, D-44), модуль `apps/api/src/promo`: `campaigns.ts` — чистые правила (скин, даты по Ташкенту, проверки 35%/25%, граница маржи); `campaigns.service.ts` — цена акции в корзине, заказе и слайд; админка — `apps/api/src/staff/admin-campaigns.ts`. Акция — строка в `promotions` с `kind = campaign`; товары — `promotion_targets` (скидка % или цена акции). Обычная цена товара не меняется, цена акции считается по часам. Миграция `20261108100000` (только добавляющая); на `vitalo_dev` — 02.11, на сервере — ещё нет.
- Под заказ из США (этап 6, D-60), модуль `apps/api/src/orders`: `cross-border.ts` — чистые правила (этапы, гарантия 21 день, отмена покупателем до заказа в США); `cross-border.service.ts` — партии, этапы, уведомления; админка — `apps/api/src/staff/admin-cross-border.ts` (страница «Посылки из США»). Товар из iHerb узнаётся по артикулу `VTL-H…` / `VTL-GH…`. Миграция `20261118100000_cross_border` (только добавляющая); на `vitalo_test` — 09.11, на `vitalo_dev` и сервере — ещё нет.

- iHerb и цены (этап 5, D-57), модуль `apps/api/src/iherb`: `wishlist-parser.ts` — разбор сохранённой страницы вишлиста и таблицы; `iherb-prices.ts` — загрузка с предпросмотром и срезы цен; `auto-price.ts` — автоцена (цена iHerb × (1 + наценка), не ниже себестоимости + минимальной наценки). Напоминания админам 09/15/21 по Ташкенту выключены по умолчанию. Внешних запросов к сайту iHerb нет (только загрузка файла владельцем). Цены конкурентов (ветка `iherb-4-competitors`, не выложено): `one-to-one.ts` — сверка «1-в-1»; `competitors.ts` — запись, ввод вручную, скрытие («Убрать» ставит `hidden_at`, запись не удаляется).

## База: основные таблицы

| Группа | Таблицы | Связи |
| --- | --- | --- |
| Покупатели | `users`, `user_sessions`, `addresses`, `favorites`, `bonus_accounts`, `bonus_ledger`, `referrals` | адрес → `regions`/`cities`; с 3.6 у `addresses` поля квартира, подъезд, этаж, ориентир (миграция `20261106100000`, только добавляющая; на сервере с 02.11.2026; координаты были раньше) |
| Каталог | `products`, `brands`, `manufacturers`, `countries`, `forms`, `categories`, `product_categories`, `product_media`, `product_relations`, `product_sku_aliases` | товар → бренд, форма; короткие названия `short_name_ru/uz` (с 2.1, миграция `20261029200000`); поля карточки товара (2.3, миграция `20261030400000`, только добавляющая, на сервере с 31.10): форма вещества, число капсул/дней, Halal/VEGE, «Стандарт», доля выгоды над Маркетом, вердикт и памятка; товар ↔ категории; бренд — адрес (`slug`), логотип, страна, «Почему в VITALO» (2.2); скрытая категория → замена (`categories.merged_into_id`, 2.2); поля iHerb (D-57, ветка `iherb-1-fields`, миграция `20261114100000_iherb_fields`, только добавляющая; пока не применена, на сервере нет): `iherb_url`, `iherb_product_id` (уникальный), `cross_border_eligible`, `auto_pricing_enabled`, `markup_percent` (80), `price_round_to` (1000), `stock_price_mode` (`freeze` / `dynamic`), `dose_amount`, `dose_unit`, `dose_per`, `match_form`; Mini App их не показывает |
| Склад | `warehouses`, `inventory`, `inventory_batches`, `inventory_movements`, `physical_units` (банки), `physical_unit_events` | остаток на товар и склад; доступно = факт − резерв |
| Закупки | `suppliers`, `purchases`, `purchase_lines`, `receiving_sessions`, `receiving_session_lines`, `purchase_events` | закупка → строки → приёмка → банки |
| Корзина и заказы | `carts`, `cart_items`, `orders`, `order_items`, `order_item_units`, `order_status_history`, `order_edit_log`, `shipments`, `cancel_requests`, `returns` | заказ → позиции → банки; история статусов; 3.3: `carts.promo_code`, `orders.promo_code`, `orders.pricing_json` (снимок расчёта скидки, миграция `20261103100000`) |
| Под заказ из США (D-60) | `cross_border_batches`, `cross_border_events` | партия «из США» (посылка) → банки; события этапов заказа; в `order_items` поля `source` (`local` / `cross_border`), `cross_border_batch_id`, `arrived_at`; в `orders` — `expected_from`, `expected_to`, `cross_border_overdue_for`; миграция `20261118100000` (только добавляющая; на `vitalo_test`, на сервере — нет) |
| Товары по поставщикам (D-61) | `suppliers` (новые поля: код, вид, сроки «под заказ», гарантия, порядок вкладок), `product_suppliers` (товар ↔ поставщики); `products.on_zero_supplier_id`; `order_items.supplier_id`, `cross_border_batches.supplier_id` | миграция `20261119100000_supply_sources` (на `vitalo_dev` и сервере не применена; содержит UPDATE существующих строк — вопрос 121) |
| Оплата | `payment_methods` (`card_transfer`, `bank_transfer`, `cod`, …), `payments`, `payment_attempts`, `manual_payment_confirmations`, `payment_receipts` | платёж → заказ; ручное подтверждение менеджером; `payment_receipts` — чеки из бота (3.1, миграция `20261101100000`, только добавляющая; на `vitalo_test`, `vitalo_dev` и на сервере — с 31.10); Payme (Merchant API): `payme_transactions` и поля товара `ikpu_code`, `package_code` (миграция `20261111100000`, только добавляющая; на `vitalo_test` и `vitalo_dev` (04.11), на сервере — с 05.11), см. [operations/PAYME.md](operations/PAYME.md) |
| Доставка | `regions`, `cities`, `delivery_tariffs` | тариф по городу, порог бесплатной доставки; с 3.6 у `regions` и `cities` есть номер СОАТО `soato_code` (уникальный; 14 областей, 207 районов и городов; миграция `20261107100000`, только добавляющая; на сервере с 02.11.2026; 27 райцентров скрыты, если нет тарифа и сохранённого адреса) |
| Маркетплейсы | `marketplace_orders`, `marketplace_order_lines`, `marketplace_order_units`, `marketplace_external_orders`, `yandex_sync_runs`, `ozon_accounts` | заказ Яндекса → строки → банки |
| Финансы | `expenses`, `expense_categories`, `tax_payments`, `payroll_*`, `finance_reminders`, `sales_daily` | — |
| Маркетинг и контент | `promotions`, `promo_codes`, `marketing_campaigns`, `content_blocks`, `home_banners`, `settings`, `analytics_events` | баннеры главной — `home_banners` (до 5, миграция `20261030100000`, применена на `vitalo_dev` и на сервере 29.10 23:45); настройки — пары ключ/значение в `settings`; манифест на главной — ключ `home_manifest` (2.4, без миграции; по умолчанию тексты из кода) |
| Скидки и промокоды (3.3) | `promotions`, `promotion_targets`, `promotion_usages` | акция → цели (товар, категория, бренд: `promotion_targets.brand_id`); у `promotions` новые поля `description_ru/uz`, `first_order_only`, `created_at`, `updated_at`; тип `PromoType` получил значение `free_delivery`; `promotion_usages.order_id` уникален — одна активация на заказ; миграция `20261103100000` (только добавляющая) |
| Акции (3.7) | `promotions` (новые поля `kind`, `title_ru/uz`, `slug`, `skin`, `open_ended`, `notify_start`, `start_notified_at`), `promotion_targets` (`discount_pct`, `campaign_price_uzs`), `cart_items.campaign_id` | акция — строка в `promotions` с `kind = campaign`; миграция `20261108100000` (только добавляющая; enum-ы `PromotionKind`, `CampaignSkin`; на сервере с 02.11.2026) |
| Совместимость (3.4) | `compat_requests`, `compat_answers` | запрос: набор товаров, язык, комментарий (чистится через 90 дней, `comment_purged_at`), статус, ответ, ссылка на сохранённое сочетание; сочетание: набор товаров + язык, вердикт, текст, вкл/выкл; миграция `20261104100000` (только добавляющая) |
| VITALO AI (3.8) | `substances`, `product_substances`, `compat_rules`, `ai_requests`, `ai_compat_answers`, `users.ai_consent_at` | справочник веществ и правила (в ответы идут только одобренные), журнал запросов к модели, кэш ответов AI; ничего не удаляется, только выключается или скрывается (миграция `20261109100000`) |
| Лист ожидания | `product_waitlist` | товар и покупатель (уникально); `notified_at` — когда бот написал «снова в наличии» (2.4, миграция `20261031100000`, только добавляющая; на сервере с 31.10); `cancelled_at` — покупатель выключил колокольчик, запись не удаляется (патч 2.4, миграция `20261031200000`, только добавляющая; на сервере с 31.10) |
| iHerb и цены (этап 5, D-57) | `iherb_uploads`, `iherb_price_snapshots`, `price_changes`, `iherb_reminders`; поля iHerb в `products` (`iherb_url`, `iherb_product_id`, наценка, округление, режим склада, доза, форма — миграция `20261114100000`, применена на `vitalo_dev` и на сервере 08.11) | загрузка вишлиста → срезы цен (`iherb_price_snapshots`, товар может быть без ссылки) → автоцена → журнал `price_changes`; миграция `20261115100000_iherb_prices` (только добавляющая) — применена на `vitalo_dev` и на сервере 08.11 |
| Цены конкурентов (этап 5, ветка 3, D-57) | `competitor_prices` (товар VITALO, площадка, название и ссылка у конкурента, цена, дата, 4 поля сверки, результат, источник вручную / ai, `hidden_at` вместо удаления) | сверка «1-в-1» проверяется по текущей карточке товара; миграция `20261116100000_competitor_prices` (только добавляющая) — применена на `vitalo_dev` 08.11 и на сервере 09.11 (выложено, `release-stage5-competitors`) |
| AI-аналитик и сигналы закупки (этап 5, ветка 4, D-59) | `admin_ai_feed` (что прислал владелец), `admin_business_memory` (память: решения и заметки; «Убрать» — `active` = false), `admin_ai_requests` (журнал запросов, стоимость с учётом кеша); поля `iherb_price_snapshots.bestseller_rank`, `competitor_prices.orders_count`; миграция `20261117100000_admin_ai_analyst` (только добавления) — применена на `vitalo_test` и `vitalo_dev` 09.11; на сервере — нет |
| Обращения «Спросить специалиста» (6а-Д) | `support_threads` (тема, статус, покупатель, товар, пометка «медицинский»), `support_messages` (сообщения покупателя и ответы специалиста); миграция `20261121100000_support_threads`, только добавляющая; медицинские вопросы видят только админ и специалист (D-40) |
| Сотрудники и аудит | `staff_users` (3.4: поле `is_specialist`), `staff_sessions` (устройство, IP, последний вход; миграция `20261113100000`, применена на сервере 08.11), `staff_devices` и `staff_login_requests`, `staff_backup_codes` (вход в браузере), `audit_logs`, `system_errors`, `legal_documents`, `legal_acceptances` | — |

## API (основное)

Все адреса начинаются с `/api`. Полный список — Swagger `http://localhost:3000/api/docs` (локально).

- Вход: `POST /auth/telegram`, `GET /auth/me`; сотрудники — `POST /staff/auth/telegram`.
- Каталог: `/catalog/products`, `/catalog/products/:id`, `/catalog/search`, `/catalog/categories`, `/catalog/brands`, `/catalog/brands/showcase` (лента «Проверенные бренды», 2.2), `/catalog/brands/:slug` (страница бренда, 2.2).
- Корзина и заказы: `/cart`, `/cart/upsell` (допродажа, 3.1), `POST /cart/promo` и `DELETE /cart/promo` (промокод: «Применить» и [✕], 3.3), `/orders/preview`, `POST /orders` (с `Idempotency-Key`), `/orders/:id/payment/...`. Настройка допродажи (админка): `GET/PUT /staff/settings/cart-upsell` (3.1).
- Промокоды (админка, 3.3): `/staff/promo-codes` — список, генерация кода, создание, `PUT /:id`, смена статуса, `POST margin-check` (проверка защиты маржи); настройка `promo_guard`: `GET/PUT /staff/promo-codes/settings`. Права: смотрит менеджер, меняют админ и маркетолог, защиту маржи — только админ.
- Доставка: `/delivery/regions`, `/delivery/quote`.
- Карта (3.6): `GET /maps/config` (статус карты, ключ не отдаёт), `POST /maps/open` (ключ JS API при открытии, лимит 100 загрузок в сутки), `GET /maps/geocode` (адрес по точке, до 40 запросов на покупателя за 10 мин); настройка карты в админке — `Настройки → Доставка → Карта (Яндекс)`. Ключи Яндекса (карта и геокодер) лежат в `.env` ноутбука и сервера; на сервере с 02.11.2026 (`release-3.6`) — те же ключи, что на ноутбуке; отдельные ключи — открытый вопрос 69 в журнале.
- Лист ожидания (2.4): покупатель — `GET /waitlist/ids`, `PUT /waitlist/:productId`; сотрудники — `/staff/waitlist`.
- Обращения (6а-Д): покупатель — `/support/threads` (список, создание, переписка, ответ); сотрудники — `/staff/support/...` (права `support.view` и `support.answer`).
- Админка: `/staff/...` (заказы, товары, склад, закупки, финансы, настройки, аналитика, сотрудники, аудит).
- Удаление товара и бренда (D-54, выложено 08.11): `DELETE /staff/products/:id`, `DELETE /staff/brands/:id` — только админ (`catalog.delete`). Защиты в базе от DELETE (`apps/api/prisma/constraints.sql`, миграция `20261112100000_d54_admin_delete`) пропускают удаление только при `vitalo.allow_delete = on` внутри транзакции API.
- Бот: `/internal/bot/...` (по секрету `BOT_API_SECRET`). Мониторинг: `GET /health` (200 / 503).

## Домены

| Адрес | Что |
| --- | --- |
| `vitalo.uz` | основной: сейчас Mini App (`apps/miniapp/dist`). Лендинг — временная страница до релиза 6; сайт = тот же Mini App в браузере (релиз 6, D-30), отдельного сайта нет |
| `admin.vitalo.uz` | админка (`apps/admin/dist`) |
| `api.vitalo.uz` | API (nginx → `vitalo-api` на порту 3000, наружу порт не открыт) |
| `vitalostore.uz` | должен перенаправлять на `vitalo.uz` (29.10 не ответил — проверить) |

Один сертификат Let's Encrypt на три адреса `vitalo.uz`, `admin.`, `api.` (`certbot.timer`).

## Сервер

- VPS Hostmaster в Узбекистане, Ubuntu 24.04, IP `91.213.99.230`; данные должны храниться в Узбекистане.
- Службы: `nginx`, `postgresql` (база `vitalo`, вход через локальный сокет), `vitalo-api`, `vitalo-bot`,
  `vitalo-backup.timer`, `certbot.timer`, `fail2ban`, `ufw` (открыты только 22/80/443).
- Папки: `/opt/vitalo/app` (код), `/opt/vitalo/repo.git` (git), `/var/lib/vitalo` (фото), `/var/lib/vitalo/receipts` (чеки клиентов, закрытая папка `RECEIPTS_DIR`, nginx её не раздаёт; с 3.1, на сервере — с 31.10, папка создаётся при первом чеке), `.env` в `apps/api`.
- Файлы настроек сервера в репозитории: `deploy/nginx`, `deploy/systemd`, `deploy/sudoers-vitalo`.

## Деплой

1. Работа сливается в `main`, на ноутбуке: `git push server main` (только пользователь).
2. На сервере: `sudo -iu vitalo /opt/vitalo/app/deploy/scripts/update.sh --check` — что придёт, ничего не меняет.
3. `update.sh` — бэкап → новый код → сборка → перезапуск → проверка. Если есть новые миграции — останавливается;
   применить их можно только `update.sh --migrate` после решения пользователя.
4. `sudo /opt/vitalo/app/scripts/server/healthcheck.sh` — проверка.

## Бэкапы

- Сервер: `scripts/server/backup.sh` каждую ночь в 03:30 (таймер) и перед каждым `update.sh`: база (сразу
  проверяется), фото, чеки (`receipts-*.tar.gz`, с 3.1), `.env`; хранение 14 дней. Проверка восстановления — `restore-check.sh`.
- Ноутбук: копии `vitalo_dev` в папке `backups\` (в git не попадают). Копии с сервера забирать к себе по
  [DEPLOY_RUNBOOK](DEPLOY_RUNBOOK.md), фаза 7.3.

## Разработка на ноутбуке

`start.bat` поднимает Docker (postgres, redis), окна API (3000), Mini App (5173), админки (5174), бота и туннеля
cloudflared. Туннель даёт временные адреса `https://…trycloudflare.com` для телефона; бот переставляет на них кнопку.
Подробно — [CLAUDE.md](../CLAUDE.md) и [MIGRATION.md](../MIGRATION.md).
