# VITALO — READ-ONLY аудит для перехода к VITALO Operations

Дата: 06.10.2026. Ветка `main`, последний коммит на момент аудита — `417b1d4`.
Метод: статическое чтение кода, `schema.prisma`, миграций, конфигурации и тестов. Ничего не запускалось: ни тесты, ни seed, ни миграции, ни сервер, ни подключения к базам. Из `.env` взяты только названия переменных, хост, порт и имя базы; секреты заменены на `***`.

Целевые документы (`docs/operations/`), прочитаны первыми: Этапы 1–6 (PDF) и Master Prompt (docx). Они описывают **TARGET STATE** и не доказывают, что что-то уже реализовано.

Обозначения:
- **CURRENT** — что есть в коде;
- **TARGET** — что требуют документы;
- **GAP** — разница между ними;
- **NOT IMPLEMENTED** — в коде нет;
- «Не подтверждено кодом» — по коду проверить нельзя.

Пути даны от корня репозитория: `apps/api/...`, `apps/admin/...`, `apps/miniapp/...`, `apps/bot/...`.

---

## 1. Executive Summary

1. **Склад сейчас — только количественный.** Таблица `inventory` хранит одну строку на пару товар×склад с полями `actual_qty` и `reserved_qty`. Журнал движений — `inventory_movements`. «Доступно» нигде не хранится и всегда вычисляется как `actual_qty − reserved_qty`. Физических единиц, Physical ID, FEFO, закупок, продаж (Sale), расходов, этикеток и задач склада **нет** (NOT IMPLEMENTED).
2. **12-часовой резерв работает и хорошо защищён.**
   - Срок не задан константой в коде: он берётся из данных, `payment_methods.timeout_minutes = 720`.
   - Резерв ставится в транзакции создания заказа. Используются условный `UPDATE … FOR UPDATE`, CHECK-ограничение в базе и ключ идемпотентности.
   - Фоновая задача раз в минуту отменяет просроченные заказы.
   - Сценарий «два покупателя на последнюю банку» покрыт e2e-тестами.
3. **Резерв превращается в списание при подтверждении оплаты, а не при доставке.** Это делает `OrderLifecycleService.confirmBankTransfer` → `StockService.deduct`: уменьшаются и `reserved_qty`, и `actual_qty`. С этого момента оплаченная, но ещё не собранная банка уже не учитывается в `actual_qty`.

   В TARGET окончательное списание происходит только в статусе *SOLD*. Это главное смысловое расхождение (раздел 15).
4. **Таблица `orders` жёстко привязана к покупателю Mini App.** Обязательны `user_id` (покупатель Telegram), получатель, телефон, `region_id`/`city_id`, адрес, суммы и номер `VTL-…`. Полей «канал» и «внешний номер» нет. При каждой смене статуса уведомление ставится в очередь покупателю. Для Yandex таблица в текущем виде **непригодна** (раздел 4в).
5. **Товар.**
   - Категорий у товара может быть несколько: таблица `product_categories`, два дерева — `need` («потребность») и `product_type` («тип продукта»).
   - Цена одна (`price_uzs`) плюс `old_price_uzs`.
   - Себестоимость одна (`cost_uzs`) на весь товар.
   - Бренд, производитель, страна и форма — свободный текст, а не справочники.
   - Цены Yandex, комиссии и логистики нет.
6. **Себестоимость видят Warehouse и Marketer.** `GET /api/staff/products/:id` отдаёт `cost_uzs` всем, у кого есть право `products.view`, а это manager, warehouse и marketer. Выручку на Dashboard видят manager и marketer. Это расходится с TARGET.
7. **Большая часть таблиц схемы в коде не используется:** `returns`, `return_items`, `cancel_requests`, `shipments`, `promotions*`, `bonus_*`, `referrals*`, `sales_daily`, `content_blocks*`, `marketing_campaigns`. Таблица `inventory_batches` (партия, срок годности, цена) только **записывается** при приходе, но нигде не читается.
8. **Окружения.** На компьютере две базы в Docker: `vitalo` (рабочая локальная) и `vitalo_test` (тесты). Production — отдельный сервер, база тоже называется `vitalo`.
   - e2e-тесты надёжно защищены от любой базы, кроме `*_test`.
   - Demo-seed защищён только от `NODE_ENV=production`, поэтому на локальной рабочей базе он запустится.
   - На сервере `update.sh` **автоматически** применяет все новые миграции к production при каждом обновлении.
9. **Самые опасные места для будущих изменений:**
   - `StockService.settle` и `returnDeducted` вычисляют, сколько держит заказ, по журналу движений с `reference_type='order'` и литералам типов `reserve`/`release`/`deduct`/`return_to_stock`;
   - CHECK `reserved_qty <= actual_qty`;
   - смысл `actual_qty` после оплаты;
   - enum `OrderStatus` (история статусов хранится текстом);
   - автоматические миграции на production.

---

## 2. Current Architecture

### 2.1 Обзор по компонентам

| Компонент | Что реально есть в коде | Ключевые файлы |
|---|---|---|
| **Mini App** | React 19 + Vite 7 + react-query 5. Экраны: `Home`, `Catalog`, `Search`, `Product`, `Cart`, `Checkout`, `Payment`, `Orders`, `Favorites`, `Addresses`, `Profile`, `Legal`, `DevLogin`. В разработке API проксируется на `/api`; в production открывается с того же домена. | `apps/miniapp/src/screens/*.tsx`, `apps/miniapp/src/lib/api.ts`, `apps/miniapp/vite.config.ts`, `apps/miniapp/dev-login-plugin.ts` |
| **Admin** | React SPA. Маршруты в `apps/admin/src/App.tsx:33-42`: `Dashboard`, `Orders`, `OrderDetail`, `Products`, `ProductEdit`, `Inventory` (вкладки «Остатки» и «Движения»), `Customers`, `CustomerDetail`, `Settings`, `Audit`. Страницы скрываются по правам через `Guard`. | `apps/admin/src/App.tsx`, `apps/admin/src/pages/*.tsx` |
| **API** | NestJS 11. Модули перечислены в `apps/api/src/app.module.ts:25-44`: Prisma, Settings, Storage, Notifications, Auth, Catalog, Delivery, Cart, Orders, Staff, Favorites, Addresses, BotInternal, Legal, Analytics. Глобальный префикс `/api`. Swagger в production выключен (`apps/api/src/main.ts:12`). | `apps/api/src/**` |
| **Bot** | grammY, long polling. Команды `/start`, `/orders`, `/profile`, `/help`, `/admin`; кнопки меню; приём контакта (телефона). Любое другое сообщение получает ответ «используйте меню» (`apps/bot/src/bot.ts:191-194`). Бот ходит в API на `/api/internal/bot/*` с ключом `BOT_API_SECRET`. **Разбора сообщений Yandex и работы в группах нет** (NOT IMPLEMENTED). | `apps/bot/src/bot.ts`, `apps/bot/src/api-client.ts`, `apps/bot/src/config.ts`, `apps/api/src/bot-internal/bot-internal.module.ts` |
| **PostgreSQL / Prisma** | PostgreSQL 16, Prisma 6.19. Схема на 1121 строку, 7 миграций. Ручной SQL лежит внутри миграций: CHECK-ограничения, view, триггеры, функции поиска. | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/*`, `apps/api/prisma/constraints.sql` |
| **Redis** | Объявлен в `docker-compose.yml` (redis:7) и в `.env` (`REDIS_URL`), `start.bat` его запускает. **В коде не используется**: нет ни зависимости, ни клиента (grep по `redis` в `apps/*/src` пуст). На production Redis нет. | `docker-compose.yml` |
| **Хранилище файлов** | `LocalFileStorage` пишет в папку `UPLOAD_DIR`. MinIO/S3 объявлены в `docker-compose.yml` и `.env` (`S3_*`), но **не используются**. | `apps/api/src/storage/file-storage.ts` |
| **Docker** | Только локально: `postgres:16`, `redis:7`, `minio` в `docker-compose.yml`. На production Docker нет: там systemd и nginx (`deploy/`). | `docker-compose.yml`, `deploy/systemd/*` |
| **Фоновые задачи** | `@nestjs/schedule`, включены, если `JOBS_ENABLED !== 'false'` (`app.module.ts:23`). Две задачи: `ReservationExpiryService.tick` раз в 60 с (`reservation-expiry.service.ts:30`) и `NotificationWorker` раз в 3 с (`notification-worker.ts:41`). | — |

### 2.2 Авторизация

| Кто | Как входит | Где в коде |
|---|---|---|
| Покупатель | `POST /api/auth/telegram`: проверка HMAC от Telegram initData, затем сессия `user_sessions` (хранится хэш токена, TTL `SESSION_TTL_HOURS`) | `apps/api/src/auth/telegram-init-data.ts`, `auth.service.ts`, `session.guard.ts` |
| Сотрудник | `POST /api/staff/auth/telegram`: та же initData плюс проверка, что есть активная строка `staff_users` с этим Telegram ID. Сессия `staff_sessions`, TTL `STAFF_SESSION_TTL_HOURS` (12 ч) | `apps/api/src/staff/staff-auth.ts` (`StaffAuthService.login`, `StaffGuard`) |
| Бот | Заголовок с `BOT_API_SECRET` (`BotSecretGuard`). В production nginx закрывает путь `/api/internal/` снаружи | `apps/api/src/bot-internal/bot-internal.module.ts:58`, `deploy/nginx/vitalo.conf` |

Права проверяются на сервере: декоратор `@RequirePermission(...)` и `StaffGuard` (`apps/api/src/staff/staff-auth.ts`) по таблице `apps/api/src/staff/permissions.ts:11-28`. Админка лишь скрывает недоступное по списку из `GET /api/staff/auth/me`.

### 2.3 Уведомления в Telegram

- **Очередь (outbox).** Таблица `notifications` (`schema.prisma:1009-1028`). Запись в очередь делается в той же транзакции, что и изменение заказа. Отправляет `NotificationWorker`: повторы с задержкой, обработка ответа 429, до 5 попыток.
- **Шаблоны** (`apps/api/src/notifications/notification-templates.ts`): `order.paid`, `order.handed_to_delivery`, `order.in_transit`, `order.delivered`, `order.cancelled`, `order.payment_reminder`, `staff.new_order`, `staff.customer_paid`.
- **Получатели-сотрудники** — только admin и manager: `ORDER_STAFF_ROLES` (`notifications.service.ts:10`), функция `toOrderStaff` (`:53`). Каждому сотруднику сообщение приходит **в личку**. Отправки в общую группу заказов нет.
- **Технический чат** — `SystemErrorsService` (`apps/api/src/notifications/system-errors.ts`): переменная `TECH_CHAT_ID`, одно и то же сообщение не чаще раза в 10 минут, без персональных данных.

---

## 3. Current Database

### 3.1 Модели, относящиеся к товарам, складу и заказам

| Модель (строки в `schema.prisma`) | Назначение | Ключевые поля и связи |
|---|---|---|
| `products` (417-466) | Товар | `sku` @unique, `name_ru`, `name_uz?`, `brand` (текст), `manufacturer` (текст), `country?`, `form?`, `price_uzs` (BigInt), `old_price_uzs?`, **`cost_uzs?`**, `min_stock`, `status` (`active`/`archived`/`hidden`), тексты RU/UZ, `search_keywords`, `popularity_30d` (нигде не пересчитывается, только читается для сортировки), габариты. Связи: `categories`, `media`, `inventory`, `batches`, `movements`, `order_items`, `cart_items`. Физически удалить нельзя (триггер `products_no_delete`). |
| `categories` (399-415) | Категория | `tree_type` = `need` \| `product_type` (enum `TreeType`, 52-55), `parent_id` (дерево), `slug` @unique, `status`. |
| `product_categories` (468-475) | Связь товар↔категория **многие-ко-многим** | PK `(product_id, category_id)` |
| `product_media` (477-494) | Фото | Варианты WebP/JPEG, миниатюра |
| `warehouses` (509-517) | Склад | `name`, `address`, `status`. Через `bootstrap:prod` создаётся один «Основной склад». |
| **`inventory`** (519-532) | Количественный остаток | `actual_qty`, `reserved_qty`, @unique `(product_id, warehouse_id)`. CHECK `inventory_qty_chk`: `actual_qty ≥ 0`, `reserved_qty ≥ 0`, `reserved_qty ≤ actual_qty`. |
| `inventory_batches` (534-547) | Партия прихода | `batch_no?`, `qty`, `cost_uzs?`, `received_at`, `expiry_date?`. **Только запись** при приходе (`admin-inventory.ts:162`) и в seed. Нигде не читается, `qty` никогда не уменьшается. |
| **`inventory_movements`** (549-566) | Журнал движений | `movement_type` (enum `MovementType`, 73-81: `receipt`, `reserve`, `release`, `deduct`, `writeoff`, `return_to_stock`, `adjustment`), `qty`, `reference_type?`, `reference_id?`, `reason?`, `created_by?` → `staff_users` |
| `carts`, `cart_items` (569-594) | Корзина | Одна активная корзина на покупателя (частичный уникальный индекс) |
| **`orders`** (608-656) | Заказ | См. 3.2 |
| **`order_items`** (658-674) | Строка заказа | `product_id`, `sku_snapshot`, `name_ru_snapshot`, **`qty` (может быть больше 1)**, `unit_price_uzs`, `line_total_uzs`, `discount_uzs`, `paid_line_total_uzs`. **Ссылки на физическую единицу нет.** |
| `order_status_history` (676-688) | История статусов | `from_status`/`to_status` хранятся **текстом**, а не enum; `changed_by_type` (`system`/`staff`/`customer`) |
| `order_edit_log` (690-700) | Правки заказа | `before_json`, `after_json`, `reason` |
| `order_number_counters` (603-606) | Счётчик номеров по дням | Номер вида `VTL-YYYYMMDD-NNNN` |
| `payment_methods` (718-727) | Способы оплаты | `code` @unique, `status`, **`timeout_minutes`** (определяет срок резерва) |
| `payments` (729-746) | Платёж по заказу | `status` (`PaymentStatus`), `amount_uzs`, `paid_at` |
| `payment_attempts` (748-759) | Попытки оплаты | — |
| `manual_payment_confirmations` (761-771) | «Я оплатил(а)» и подтверждение менеджером | `customer_confirmed_at`, `verified_by`, `verified_at` |
| `manager_tasks` (773-786) | Задачи менеджера | `type` (enum `TaskType`, 265-270: `payment_check`, `bank_transfer_check`, `refund`, `other`), `status` (`open`/`in_progress`/`done`), `order_id?` |
| `returns`, `return_items`, `return_media` (914-951) | Возвраты | **Только схема, в коде не используются** |
| `cancel_requests` (702-715) | Запрос на отмену | **Только схема** |
| `shipments` (596-601) | Объединение доставок | **Только схема** |
| `sales_daily` (1098-1108) | Агрегаты продаж | **Только схема** |
| `staff_users` (364-384), `staff_sessions` (386-396) | Сотрудники и их сессии | `role` (enum `StaffRole`: admin, manager, warehouse, marketer), `status` |
| `users`, `user_sessions`, `addresses` (273-362) | Покупатели | `telegram_user_id` @unique |
| `audit_logs` (1056-1069) | Журнал действий (Action Log) | `staff_user_id?`, `action`, `entity_type`, `entity_id?`, `before_json`, `after_json` |
| `idempotency_keys` (1082-1090) | Защита от двойного создания заказа | `key` @unique, `request_hash`, `response_json` |
| `settings` (1092-1096) | Настройки (JSON по ключу) | Например `payment_reminder_hours`, `card_transfer_details` |
| `system_errors`, `notifications`, `analytics_events` | Технические таблицы | — |
| `regions`, `cities`, `delivery_tariffs` | Доставка | `delivery_tariffs.is_test`, сроки `min_days`/`max_days` |

Модели, которые **в коде `apps/api/src` и `apps/api/scripts` не используются** (проверено поиском имени модели): `bonus_accounts`, `bonus_ledger`, `cancel_requests`, `content_blocks`, `content_block_items`, `marketing_campaigns`, `product_relations`, `promo_codes`, `promotion_targets`, `promotion_usages`, `referrals`, `referral_attributions`, `return_items`, `return_media`, `sales_daily`, `shipments`, а также `returns` (только как слово в комментариях).

### 3.2 `orders` — обязательные поля

`order_number` @unique, `user_id` → `users` (обязательно), `status` (`OrderStatus`), `payment_status` (`PaymentStatus`), `recipient_name`, `recipient_phone`, `region_id` → `regions`, `city_id` → `cities`, `address_text`, `delivery_method` (сейчас всегда `'courier'`), `delivery_cost_uzs`, `goods_total_uzs`, `goods_paid_uzs`, `total_uzs`.

Необязательные: `reserved_until`, `paid_at`, `delivered_at`, `cancelled_at`, `payment_reminder_sent_at`, `shipment_id`, `promo_id`, координаты, комментарий.

Индекс `(status, reserved_until)` нужен для задачи истечения резерва.

### 3.3 Ручной SQL в миграциях

| Что | Где | Назначение |
|---|---|---|
| CHECK `inventory_qty_chk` | `migrations/20261002103146_init/migration.sql:1230`, копия в `prisma/constraints.sql:5-6` | `actual ≥ 0`, `reserved ≥ 0`, `reserved ≤ actual` |
| VIEW `inventory_available` | init: 1233; `constraints.sql:9-11` | `available_qty = actual_qty − reserved_qty`. **В коде не используется**: доступность считается в TypeScript и Prisma. |
| CHECK `bonus_balance_chk` | init: 1238 | Баланс бонусов не меньше нуля |
| Уникальные частичные индексы `addresses_one_primary`, `carts_one_active` | init: 1241, 1245 | Один основной адрес и одна активная корзина |
| Триггер `bonus_ledger_immutable` | init: 1251-1258 | Записи бонусного журнала нельзя менять и удалять |
| Триггер `products_no_delete` | init: 1261-1268 | Товар нельзя удалить |
| GIN-индексы trigram, функции `vitalo_norm`, `vitalo_product_doc` | init: 1271-1273; `20261002130000_search_normalization` | Поиск с опечатками |
| Данные (INSERT … ON CONFLICT / NOT EXISTS) | `20261003120000_*` (способ `card_transfer`, 720 мин), `20261004100000_*` (регионы, тарифы, тексты оферты), `20261004200000_*`, `20261004300000_*` | Справочники и настройки |

Глобальная настройка тестов (`test/global-setup.ts`) очищает таблицы через `TRUNCATE … CASCADE`, обходя триггеры запрета удаления. Работает только на базе `*_test`.

### 3.4 Ответ на вопрос г): товар, категории, цена, себестоимость, SKU

| Вопрос | CURRENT | TARGET (Этап 1 §12, Этап 4 §4) | GAP |
|---|---|---|---|
| Сколько категорий у товара | **Несколько**: связь многие-ко-многим через `product_categories` (`schema.prisma:468-475`). Два дерева: `TreeType.need` («потребность») и `TreeType.product_type` («тип продукта») (`:52-55`, `categories.tree_type`), до 3 уровней. Админка передаёт `category_ids[]` (`admin-products.ts`, `create`/`update`), импорт Excel заполняет **оба** дерева (`product-import.ts:279-300`), каталог фильтрует по категории с учётом подкатегорий (`catalog.service.ts:102-109`). Справочник категорий — `reference-data.ts:18-50`. | «Категория у товара одна» | **Конфликт** (раздел 15): изменение затрагивает навигацию Mini App, фильтры, импорт и данные уже загруженных товаров |
| Цена | `products.price_uzs` (одна цена, она же цена VITALO), `products.old_price_uzs` (для показа скидки). В заказ фиксируется `order_items.unit_price_uzs`, в корзину — `cart_items.unit_price_snapshot_uzs` | `yandexPrice`, `vitaloPrice`, `yandexCommissionPercent`, `yandexLogisticsFixed`, признак «требует синхронизации» | Цены Yandex, комиссии, логистики и синхронизации нет |
| Себестоимость | `products.cost_uzs` (одна на товар, вводится в админке или импортом) и `inventory_batches.cost_uzs` (по приходу; нигде не читается). В заказ и в продажу себестоимость **не фиксируется**; `sales_daily.cost_uzs` не используется | `PhysicalUnit.actualCost` из `PurchaseLine` с пропорциональным распределением; `Sale.costAtSale` | NOT IMPLEMENTED |
| SKU | `products.sku` @unique (`:419`), в заказе — `order_items.sku_snapshot` | Главный идентификатор, по возможности совпадает с Yandex SKU | Есть, можно использовать. Совпадение с Yandex SKU по коду не проверить («Не подтверждено кодом») |
| Бренд, производитель, страна, форма | Свободный текст в `products` (`brand` NOT NULL, `manufacturer` NOT NULL, `country?`, `form?`); фильтры Mini App берут уникальные значения (`GET /api/catalog/brands`, `/forms`) | Управляемые справочники | Справочников нет |

---

## 4. Current Order Flow

### 4.1 Последовательность шагов

| Шаг | Endpoint | Контроллер → сервис → метод | Таблицы и поля | Уведомления |
|---|---|---|---|---|
| Предпросмотр | `POST /api/orders/preview` | `OrdersController.preview` → `OrdersService.preview` (`orders.service.ts:73-84`) | Только чтение, `StockService.availability` | — |
| **Создание** | `POST /api/orders` + заголовок `Idempotency-Key` (обязателен, `orders.controller.ts:69-83`) | `OrdersService.create` (92-118) → `createInTx` (257-336), одна транзакция `TX_OPTIONS {maxWait 10 s, timeout 20 s}` | `idempotency_keys` (insert, затем update `response_json`); **`StockService.reserve`** (263): `inventory.reserved_qty += qty`, `inventory_movements` (`reserve`, `reference_type='order'`); `orders` (`status='awaiting_payment'`, `payment_status='payment_pending'`, **`reserved_until = now + method.timeout_minutes`** (302)); `order_items`; `payments` + `payment_attempts`; `order_number_counters`; `order_status_history` ×2 (`new`, `awaiting_payment`); `cart_items` (купленные строки удаляются) | `staff.new_order` админам и менеджерам; покупателю — `orderStatusChanged` внутри `addHistory` |
| Реквизиты | `GET /api/orders/:id/payment/bank-transfer` | `OrdersService.bankTransferDetails` (190-216) | Чтение `settings` | — |
| **«Я оплатил(а)»** | `POST /api/orders/:id/payment/bank-transfer/paid` | `OrdersService.reportBankTransferPaid` (219-255), под блокировкой строки заказа | `manual_payment_confirmations` (`customer_confirmed_at`, `receipt_url`), `manager_tasks` (`bank_transfer_check`). **Склад не меняется** | `staff.customer_paid` админам и менеджерам |
| **Подтверждение оплаты** | `POST /api/staff/orders/:id/confirm-payment` (право `orders.payment`, то есть manager/admin) | `AdminOrdersController.confirmPayment` → `AdminOrdersService.confirmPayment` (`admin-orders.ts:199-206`) → **`OrderLifecycleService.confirmBankTransfer`** (`order-lifecycle.service.ts:78-129`) | **`StockService.deduct`** (92): `reserved_qty −= q`, **`actual_qty −= q`**, движение `deduct`; `payments` → `payment_success`; `payment_attempts` → `success`; `manual_payment_confirmations` (`verified_by`/`at`); `orders` → `paid`, `paid_at`, `reserved_until=null`; `manager_tasks` → `done`; `order_status_history`; `audit_logs` (`order.bank_transfer_confirmed`) | Покупателю — `order.paid` |
| Сборка | `POST /api/staff/orders/:id/status {status:'picking'}`, затем `'handed_to_delivery'` (право `orders.fulfil`: manager, warehouse) | `AdminOrdersService.changeStatus` (209-225), шаги заданы в `FULFILMENT_STEPS` (37-42) | `orders.status`, `order_status_history`, `audit_logs`. **Склад не меняется** | Покупателю: на `picking` не отправляется, на `handed_to_delivery` — отправляется |
| Доставка | тот же endpoint: `in_transit`, `delivered` (право `orders.deliver`: только manager) | то же | `orders.status`; при `delivered` — `delivered_at`. **Склад не меняется** | `order.in_transit`, `order.delivered` |
| Отмена покупателем | `POST /api/orders/:id/cancel` | `OrdersService.cancelByCustomer` (173-184) → `lifecycle.cancelUnpaid` (46-72) | Только статусы `new`/`awaiting_payment` (`CUSTOMER_CANCELLABLE`, `order-state.ts:22`). После «Я оплатил(а)» — отказ `PAYMENT_BEING_CHECKED`. `StockService.release`: `reserved_qty −= q`, движение `release`; заказ → `cancelled`, платёж → `payment_cancelled` | `order.cancelled` |
| Отмена сотрудником | `POST /api/staff/orders/:id/cancel` (право `orders.cancel`: manager) | `AdminOrdersService.cancel` (228-244) | Только в `EDITABLE_STATUSES` = `new`, `awaiting_payment`, `paid`, `picking` (45). Неоплаченный заказ → `cancelUnpaid`. Оплаченный → `cancelPaid` (136-151) → **`StockService.returnDeducted`**: `actual_qty += q`, движение `return_to_stock`, задача `refund` | `order.cancelled` |
| Отмена после передачи в доставку | — | **NOT IMPLEMENTED**: ответ `ORDER_LOCKED`; таблица `cancel_requests` не используется | — | — |
| Возврат по заказу | — | **NOT IMPLEMENTED**: статус `return` есть в enum и в `ORDER_TRANSITIONS` (`delivered → return`), но `ChangeStatusDto` его не принимает (`admin-orders.ts:64-70`). Таблица `returns` не используется. Возврат на склад — отдельная ручная операция `POST /api/staff/inventory/return`, **без ссылки на заказ** | — | — |

### 4.2 Машина состояний (`apps/api/src/orders/order-state.ts:9-19`)

`new → awaiting_payment → paid → picking → handed_to_delivery → in_transit → delivered → return`; отмена (`cancelled`) возможна из любого статуса до `in_transit` включительно.

Статус оплаты хранится отдельно (`payment_status`).

### 4.3 Ответы на вопросы д) и в)

**д) Статусы и enum — что опасно менять.**
- `OrderStatus` — enum PostgreSQL (`schema.prisma:89-99`). Он используется в:
  - `ORDER_TRANSITIONS`, `CUSTOMER_CANCELLABLE`, `FULFILMENT_STEPS`, `EDITABLE_STATUSES`;
  - фильтрах `ReservationExpiryService` (`status in ['new','awaiting_payment']`);
  - `DashboardService` (группировка по статусам);
  - шаблонах уведомлений (`order.<status>`);
  - фильтре `StaffOrdersQuery` (`@IsEnum`);
  - подписях статусов в Mini App и Admin.
- `order_status_history.from_status`/`to_status` — это **текст**. Поэтому:
  - переименование значения не меняет старые записи истории;
  - удаление значения невозможно, пока на него ссылаются строки `orders`.
- **Добавить** значение (`ALTER TYPE … ADD VALUE`) безопасно для текущего потока. Ограничение PostgreSQL: новое значение нельзя использовать в той же транзакции, где оно добавлено.
- **Переименование или удаление** значений сломает исторические заказы, историю и проверки статусов в коде.
- Те же правила действуют для `PaymentStatus` и `MovementType`. Для `MovementType` это особенно критично: SQL в `StockService` сравнивает типы по строковым литералам (раздел 5).

**в) Пригодна ли `orders` для заказов Yandex** — **нет, в текущем виде не пригодна.**
- Обязательны `user_id → users` (покупатель Telegram), получатель и телефон, `region_id`/`city_id` (FK на справочник регионов Узбекистана), `address_text`, а также все суммы.
- `order_number` всегда формируется как `VTL-…` (`OrdersService.nextOrderNumber`, 401-408).
- Полей `channel` и `external_order_number` нет.
- `OrderLifecycleService.addHistory` (158-172) **всегда** ставит в очередь уведомление покупателю `order.user_id`.
- Endpoint'ы покупателя ищут заказы по `user_id`.
- `DashboardService` считает выручку по всем оплаченным заказам, без разделения на каналы.
- Отдельной сущности или общего интерфейса для заказа из другого канала нет. Решение — за вами (раздел 16).

---

## 5. Current Reservation Flow (12 часов)

### 5.1 Где определяется 12-часовой резерв

| Вопрос | Ответ |
|---|---|
| Константа в коде | **Её нет.** Срок вычисляется так: `reserved_until = now + method.timeout_minutes * 60_000` (`apps/api/src/orders/orders.service.ts:302`, внутри `createInTx`). |
| Где задано значение 12 ч | В данных: `payment_methods.timeout_minutes = 720`. Для `card_transfer` — в миграции `20261003120000_ux_categories_payment_texts/migration.sql:14-15`. Для `bank_transfer` и `card_transfer` — в `apps/api/prisma/reference-data.ts:53-54` (`12 * 60`); это значение используют `seed.ts` и `bootstrap.ts` (production). У Payme/Click/Uzum значение 30 мин, но эти способы выключены. |
| Можно ли поменять в админке | **Нет**: в админке нет экрана или endpoint'а для `timeout_minutes` (поиск `timeout_minutes` в `src` находит только строку 302). Менять можно только в базе. |
| Напоминание | За `payment_reminder_hours` (настройка, по умолчанию 3) до отмены: `ReservationExpiryService.remindOnce` (`reservation-expiry.service.ts:53-87`), не чаще одного раза на заказ (`payment_reminder_sent_at`). |
| Фоновая задача | `ReservationExpiryService.tick`, `@Interval('reservation-expiry', 60_000)` (`:30`). Внутри: `remindOnce` → `runOnce` (90-123) → очистка просроченных `idempotency_keys`. Флаг `running` не даёт двум прогонам наложиться в одном процессе. Задача включена, только если `JOBS_ENABLED !== 'false'`. |
| Транзакции | Создание заказа — одна интерактивная транзакция (`orders.service.ts:101-108`). Каждая отмена в задаче — отдельная транзакция на каждый заказ (`:105`), до 100 заказов за прогон (`BATCH`). |
| Уровень изоляции | Явно не задан нигде (поиск `isolationLevel` в `src` пуст), значит используется **READ COMMITTED** по умолчанию. |
| Блокировки | (1) Строка склада: `StockService.reserveLine` (`stock.service.ts:118-137`) — CTE `SELECT … FOR UPDATE` плюс условный `UPDATE … WHERE actual_qty − reserved_qty >= qty`, одна повторная попытка. (2) Порядок блокировок фиксированный — по `product_id` (`:51`), чтобы не было взаимной блокировки. (3) Строка заказа: `OrderLifecycleService.lockOrder` — `SELECT … FOR UPDATE` (37-43), используется в отмене, подтверждении, «Я оплатил(а)», напоминании и задаче истечения. (4) Страховка в базе — CHECK `reserved_qty <= actual_qty`. |
| Идемпотентность | Создание заказа — таблица `idempotency_keys`: ключ вставляется первым в транзакции, параллельный дубль ждёт на уникальном индексе и затем получает сохранённый ответ (92-118). Отмена — `cancelUnpaid` возвращает `already_cancelled`. Подтверждение — `already_paid`. Списание и возврат вычисляются из журнала движений, поэтому повторный вызов ничего не меняет. «Я оплатил(а)» при повторе возвращает текущее состояние. |

### 5.2 Сценарии

| Сценарий | Что происходит (по коду) |
|---|---|
| **Автоотмена** | `runOnce`: заказы в `new`/`awaiting_payment`, `payment_pending`, `reserved_until < now`, **без «Я оплатил(а)»**. Всё перепроверяется под блокировкой → `cancelUnpaid` → `StockService.release` (`reserved_qty −= held`, движение `release`), заказ → `cancelled`, платёж → `payment_cancelled`, история с `actor=system`, уведомление с причиной «истёк срок». |
| **«Я оплатил(а)»** | Если `reserved_until <= now`, возвращается ошибка `RESERVATION_EXPIRED`, даже если задача ещё не отменила заказ (`orders.service.ts:228-230`). Иначе создаётся `manual_payment_confirmations` и задача `bank_transfer_check`. С этого момента **задача истечения такой заказ не отменяет никогда** (`reservation-expiry.service.ts:96`), и резерв держится до решения менеджера. Срока ожидания проверки нет. |
| **Подтверждение после истечения резерва** | `confirmBankTransfer` **не проверяет `reserved_until`**, он проверяет только `cancelled` (`order-lifecycle.service.ts:80-82`). (1) Заказ ещё не отменён (покупатель нажал «Я оплатил(а)», или задача ещё не дошла до него) → подтверждение проходит, удерживаемый резерв списывается. Это корректно: резерв не освобождался. (2) Задача уже отменила заказ → ошибка `ORDER_CANCELLED`. **Восстановить отменённый заказ нельзя** (NOT IMPLEMENTED); деньги, пришедшие после отмены, обрабатываются только вручную, вне системы. |
| **Два заказа на последнюю единицу** | Оба запроса доходят до `reserveLine`. Первый берёт блокировку строки `inventory` и делает `reserved_qty += 1`. Второй ждёт; после фиксации первого PostgreSQL перепроверяет условие `actual − reserved >= qty`, строка уже не подходит, повторная попытка тоже возвращает 0 строк → `null` → `ConflictException INSUFFICIENT_STOCK`, и вся транзакция второго заказа откатывается. Страховка — CHECK в базе. Покрыто тестами `orders.e2e-spec.ts:278` («10 покупателей на последние 5 штук — ровно 5 успешных») и `:293`. |

### 5.3 Риски гонок (по коду)

1. **Обход общего пути.** Ручные операции склада (`AdminInventoryService.op`) блокируют ту же строку `FOR UPDATE` и запрещают трогать зарезервированное (`STOCK_RESERVED`), поэтому они безопасны. Но **любой новый код, который меняет `inventory` в обход `StockService` и `AdminInventoryService`**, лишится этих гарантий.
2. **`settle()` и `returnDeducted()`** вычисляют, сколько держит заказ, суммируя журнал движений с `reference_type='order' AND reference_id=<order>` по литералам `'reserve'`, `'release'`, `'deduct'`, `'return_to_stock'` (`stock.service.ts:89-96`, `141-148`). Если новый код запишет туда движения с тем же `reference_type` и этими типами, расчёт исказится.
3. **Несколько складов.** `reserveLine` выбирает один склад с наибольшим остатком; строка заказа резервируется целиком в одном складе. Сейчас склад один, проблем нет.
4. **Задача на нескольких экземплярах API** безопасна: под блокировкой всё перепроверяется. Подтверждено тестом `orders.e2e-spec.ts:504`.
5. **Бессрочный резерв** после «Я оплатил(а)», если менеджер не отреагировал. Это не гонка, а операционный риск.

### 5.4 Ответ на вопрос а): можно ли назначать PhysicalUnit ПОСЛЕ подтверждения оплаты, не ломая резерв

**Где резерв превращается в списание:**
1. `AdminOrdersController.confirmPayment` (`admin-orders.ts:322-328`)
2. → `AdminOrdersService.confirmPayment` (`:199-206`, транзакция с блокировкой строки заказа `inOrderTx`)
3. → `OrderLifecycleService.confirmBankTransfer` (`order-lifecycle.service.ts:78-129`)
4. → `this.stock.deduct(tx, order.id, staffId)` (`:92`)
5. → `StockService.settle(…, 'deduct')` (`stock.service.ts:140-174`), где выполняется `UPDATE inventory SET reserved_qty = reserved_qty − held, actual_qty = actual_qty − held` (`:154-156`) и создаётся движение `deduct`.

Больше нигде резерв в списание не превращается.

**Вывод по коду: технически — да.**
- Резерв ставится при создании заказа (`OrdersService.createInTx:263`) и до оплаты никак не связан с конкретной единицей.
- Подтверждение оплаты — одна транзакция под блокировкой заказа, и в неё можно встроить следующий шаг, не трогая логику резерва (`reserve`, `release`, задача истечения, «Я оплатил(а)» не меняются).

**Ограничения, которые видны в коде:**
1. **Смысл `actual_qty`.** После `deduct` оплаченная банка исчезает из `actual_qty`, хотя физически ещё на складе до сборки и доставки. Если единица после оплаты будет в статусе «VITALO доставка» (TARGET), количественный и поштучный учёт разойдутся по смыслу, пока не определено, что значит `actual_qty` (раздел 16, Q1).
2. **Количество в строке заказа.** `order_items.qty` бывает больше 1, а в TARGET (Этап 4 §7, §17) связь `OrderItem 0..1 → PhysicalUnit`. Для строки с `qty = 3` нужно три единицы; одного поля `assignedPhysicalUnitId` на строку недостаточно (раздел 15).
3. **Отмена оплаченного заказа** (`cancelPaid` → `StockService.returnDeducted`, `:88-116`) возвращает количество. При поштучном учёте должна вернуться и единица (её назначение нужно снять).
4. **Не хватило единиц по FEFO в момент оплаты** (количество было, а свободных единиц нет — например, они ушли в Yandex мимо `inventory`). В коде такого исхода нет; подтверждение оплаты сейчас никогда не отказывает из-за склада.
5. **Журнал движений.** `settle` и `returnDeducted` считают движения с `reference_type='order'` и типами `reserve`/`release`/`deduct`/`return_to_stock`. Поштучные движения с тем же `reference_type` и теми же типами исказят расчёт.
---

## 6. Current Inventory Model

### 6.1 Модель

`inventory` хранит одну строку на пару товар×склад: `actual_qty` (сколько есть физически по учёту) и `reserved_qty` (держат неоплаченные заказы). «Доступно» = `actual_qty − reserved_qty` нигде не хранится. Каждое изменение пишется строкой в `inventory_movements`. Физической единицы нет; партия (`inventory_batches`) с остатком никак не связана.

### 6.2 Все места, где напрямую меняются `actual_qty`, `reserved_qty` и `inventory_movements`

| # | Файл : функция | Операция | `actual_qty` | `reserved_qty` | Движение | В транзакции? |
|---|---|---|---|---|---|---|
| 1 | `apps/api/src/inventory/stock.service.ts` : `reserve` → `reserveLine` (48-72, 118-137) | Создание заказа | — | `+qty` (SQL `UPDATE`) | `reserve`, `reference_type='order'` | Да, транзакция заказа; `FOR UPDATE` |
| 2 | `stock.service.ts` : `release` → `settle` (75-77, 140-174) | Отмена неоплаченного заказа (покупателем, сотрудником, задачей) | — | `−held` | `release`, `order` | Да, под блокировкой строки заказа |
| 3 | `stock.service.ts` : `deduct` → `settle` (80-82, 153-156) | **Подтверждение оплаты** | **`−held`** | `−held` | `deduct`, `order` | Да, под блокировкой строки заказа |
| 4 | `stock.service.ts` : `returnDeducted` (88-116) | Отмена оплаченного заказа сотрудником (до передачи в доставку) | `+списано` | — | `return_to_stock`, `order` | Да, под блокировкой строки заказа |
| 5 | `apps/api/src/staff/admin-inventory.ts` : `receipt` (159-175) | Приход (`POST /api/staff/inventory/receipt`) | `+qty` | — | `receipt` (без ссылки); плюс строка `inventory_batches` (партия, цена, срок) | Да; `FOR UPDATE` строки склада (`op`, 220-250) |
| 6 | `admin-inventory.ts` : `writeoff` (177-190) | Списание | `−qty` (не ниже резерва) | — | `writeoff` | Да; `FOR UPDATE` |
| 7 | `admin-inventory.ts` : `adjustment` (193-204) | Пересчёт (инвентаризация) | `= посчитанное` (не ниже резерва) | — | `adjustment` (разница со знаком) | Да; `FOR UPDATE` |
| 8 | `admin-inventory.ts` : `returnToStock` (207-218) | Возврат на склад (без заказа) | `+qty`, если `resellable`; иначе не меняется | — | `return_to_stock`; для непригодного — ещё и `writeoff` | Да; `FOR UPDATE` |
| 9 | `apps/api/src/import/product-import.ts` (421-426) | Импорт из Excel | Через №5 (`receipt`) или №7 (`adjustment`) | — | Как в №5 и №7, `staffId=null` | Да (через `AdminInventoryService`) |
| 10 | `apps/api/prisma/seed.ts` (197-204) | Демо-данные | Прямой `inventory.create` | Прямо | `receipt` | Seed (только тестовая/демо база) |
| 11 | `apps/api/test/helpers.ts` (71, 77) | Подготовка тестов | Прямой `create` / `updateMany` | Прямо | — | Только тесты |

Других мест нет. Поиск по `actual_qty|reserved_qty|inventory_movements|inventory.(update|upsert|create)` в `apps/*/src`, `scripts` и `prisma` ничего больше не находит.

### 6.3 `inventory_batches` и срок годности

- **Запись:** `AdminInventoryService.receipt` (`admin-inventory.ts:162-171`) и `seed.ts:201`. Поле срока годности в форме прихода есть в админке (`apps/admin/src/pages/Inventory.tsx:199-202`).
- **Чтение:** **нигде.** Партии не используются ни при резерве, ни при списании, ни в отчётах; `qty` партии не уменьшается.
- Итог: срок годности **хранится только в схеме и при приходе**. FEFO и контроль сроков — NOT IMPLEMENTED.

### 6.4 Как Mini App считает «в наличии» (ответ на вопрос б)

| Где | Формула |
|---|---|
| Карточка и список: `apps/api/src/catalog/product.mapper.ts:57-59` `availableQty()` | `max(actual_qty − reserved_qty)` по складам; `in_stock = availableQty > 0` (`:73`); `available_qty = min(availableQty, 99)` (`:83`) |
| Фильтр и сортировка «в наличии»: `apps/api/src/catalog/catalog.service.ts:119-121` | `inventory.some(actual_qty > reserved_qty)` |
| Корзина, оформление, предпросмотр: `StockService.availability` (`stock.service.ts:31-41`) | `max(actual − reserved)` по складам |
| Окончательная проверка | Только условный `UPDATE` в `reserveLine` в момент создания заказа |

**б) Если свободные единицы будут уходить в заказы Yandex без количественного резерва**, Mini App об этом **не узнает**. Её единственный источник — строка `inventory` (`actual_qty − reserved_qty`). Любое движение товара, которое не изменило `actual_qty` или `reserved_qty` (в том числе будущее назначение PhysicalUnit в Yandex), даст продажу лишнего: Mini App покажет «в наличии», а `reserveLine` успешно зарезервирует количество, которого физически уже нет. Значения `available_qty` из PhysicalUnit в коде нет (NOT IMPLEMENTED). Как согласовать два учёта — решение за вами (раздел 16).

### 6.5 Что в количественной модели придётся менять при переходе к PhysicalUnit + FEFO

| Место | Почему затронуто |
|---|---|
| `StockService.deduct` (`actual_qty −` при оплате) | В TARGET окончательное списание происходит при *SOLD*, а после оплаты единица переходит в «VITALO доставка» и физически ещё на складе |
| `StockService.returnDeducted` | Отмена оплаченного заказа должна вернуть **конкретную** единицу |
| `AdminInventoryService.receipt` | В TARGET приход делается из `Purchase`, создаёт N единиц с Physical ID и сроком; сейчас приход — просто `+qty` и одна строка партии |
| `writeoff`, `adjustment`, `returnToStock` | В TARGET они работают с конкретной единицей; для списания нужно второе подтверждение |
| `product-import.ts` (остаток через приход/пересчёт) | Импорт задаёт остаток числом, а не единицами |
| `product.mapper.availableQty`, `catalog.service` (in_stock), `StockService.availability`, `DashboardService` (низкие остатки), `AdminInventoryService.stock`, `AdminProductsService` (остатки) | Все читают `actual_qty − reserved_qty` |
| CHECK `inventory_qty_chk` | Требует `reserved ≤ actual`; при любом смешанном учёте это ограничение действует |

---

## 7. Roles & Permissions

### 7.1 Где реализовано

- Таблица прав: `apps/api/src/staff/permissions.ts:11-28`. Роль `admin` получает всё неявно, через `can()` (`:32-34`).
- Проверка: `StaffGuard` и `@RequirePermission(...)` в `apps/api/src/staff/staff-auth.ts`. Дополнительная проверка шага внутри `AdminOrdersService.changeStatus` (`admin-orders.ts:215`).
- В админке: `Guard` в `apps/admin/src/App.tsx:18-20`, меню строится по `permissions` из `/api/staff/auth/me`.

### 7.2 Матрица (CURRENT)

| Право | Endpoint'ы | Admin | Manager | Warehouse | Marketer |
|---|---|---|---|---|---|
| `dashboard.view` | `GET /staff/dashboard`, `/staff/dashboard/funnel` (выручка, средний чек, топ товаров, воронка) | ✅ | ✅ | ❌ | ✅ |
| `orders.view` | `GET /staff/orders`, `/staff/orders/:id` (включая суммы, получателя, телефон) | ✅ | ✅ | ✅ | ❌ |
| `orders.payment` | `POST /staff/orders/:id/confirm-payment` | ✅ | ✅ | ❌ | ❌ |
| `orders.fulfil` | `POST /staff/orders/:id/status` (paid→picking→handed_to_delivery) | ✅ | ✅ | ✅ | ❌ |
| `orders.deliver` | тот же (handed→in_transit→delivered) | ✅ | ✅ | ❌ | ❌ |
| `orders.cancel` / `orders.edit` | `POST /staff/orders/:id/cancel`, `PATCH /staff/orders/:id` | ✅ | ✅ | ❌ | ❌ |
| `products.view` | `GET /staff/products`, **`GET /staff/products/:id` (с `cost_uzs`)** | ✅ | ✅ | ✅ | ✅ |
| `products.edit` | `POST/PATCH /staff/products`, архив, фото | ✅ | ❌ | ❌ | ❌ |
| `inventory.view` | `GET /staff/inventory`, `/movements`, `/warehouses` | ✅ | ✅ | ✅ | ❌ |
| `inventory.edit` | `POST /staff/inventory/receipt\|writeoff\|adjustment\|return` | ✅ | **❌** | ✅ | ❌ |
| `customers.view` / `customers.block` | `/staff/customers*` | ✅ | ✅ | ❌ | ❌ |
| `settings.manage` | `/staff/settings/*`, `/staff/legal/*` | ✅ | ❌ | ❌ | ❌ |
| `staff.manage` | `/staff/users*` | ✅ | ❌ | ❌ | ❌ |
| `audit.view` | `GET /staff/audit` | ✅ | ❌ | ❌ | ❌ |

Экраны (`App.tsx:33-42`): Warehouse видит «Заказы», «Товары», «Склад». Marketer — «Dashboard» и «Товары». Manager — всё, кроме «Настроек» и «Журнала». Это подтверждено тестом `apps/admin/src/admin.test.tsx:21-30`.

### 7.3 Где видна себестоимость (`cost_uzs`)

| Место | Кто видит |
|---|---|
| `GET /api/staff/products/:id` → `toAdminProduct` (`apps/api/src/staff/admin-products.ts:126-143`, поле `cost_uzs` на строке 132) | **Все с `products.view`: manager, warehouse, marketer** |
| `apps/admin/src/pages/ProductEdit.tsx:180-181` поле «Себестоимость, сум» | Показывается всем, кто открывает карточку товара; без `products.edit` — только для чтения |
| `POST /api/staff/inventory/receipt` поле `cost_uzs` (`admin-inventory.ts:22`), форма «Закупочная цена за шт.» (`Inventory.tsx:195-196`) | **Warehouse вводит закупочную цену** |
| `GET /staff/products` (список), движения склада | Себестоимости нет |
| Dashboard | Выручка (не себестоимость) — manager и marketer |

**GAP по ролям относительно TARGET:**
- Warehouse и Marketer видят себестоимость, а Warehouse вводит закупочную цену.
- Manager и Marketer видят выручку.
- Manager не может делать складские операции.
- Marketer видит Dashboard с выручкой.
- Второго подтверждения для списания нет.

---

## 8. Test / Production Environments

### 8.1 Факты

| Окружение | Как запускается | База | Откуда берутся настройки |
|---|---|---|---|
| **Local (dev)** | `start.bat`: Docker Desktop → `docker compose up -d postgres redis` → отдельные окна `npm run start:dev` (API, :3000), `npm run dev` (Mini App :5173, Admin :5174), бот `npm run dev`, туннель cloudflared (если установлен) | **`postgresql://vitalo:***@localhost:5432/vitalo`** (Docker, база `vitalo`). В `CLAUDE.md` именно она названа «рабочей базой». | `apps/api/.env` (`NODE_ENV=development`, `JOBS_ENABLED` не задан, значит фоновые задачи **включены**). Бот читает тот же `apps/api/.env` (`apps/bot/src/config.ts:8,22`). Какой токен бота там лежит (тестовый или рабочий), по коду не определить — «Не подтверждено кодом». |
| **`stop.bat`** | Закрывает окна, запущенные `start.bat` (по заголовку `title VITALO *`); освобождает порты 3000/5173/5174 (`taskkill`); `docker compose stop postgres redis`. Данные сохраняются | — | — |
| **Local e2e-тесты** | `npm run test:e2e` (apps/api) → `jest --config test/jest-e2e.json --runInBand` | **`vitalo_test`** на том же Docker (`apps/api/test/test-env.ts:4`) | `test/setup-env.ts` переписывает `process.env` значениями `TEST_ENV` раньше, чем загрузится `.env`. `test/global-setup.ts`: если имя базы не оканчивается на `_test`, работа прерывается; затем `prisma migrate deploy`, `TRUNCATE` всех таблиц, демо-seed |
| **Local unit-тесты** | `npm test` (apps/api, `*.spec.ts` в `src`), vitest в miniapp/admin/bot | Не обращаются к базе (в `*.spec.ts` нет `PrismaClient` и `DATABASE_URL`) | — |
| **`.claude/launch.json`** | 6 конфигураций: `vitalo-api`, `vitalo-miniapp`, `vitalo-admin` работают на `.env`, то есть на базе `vitalo`. `vitalo-api-testdb` (:3100) — с `DATABASE_URL=…/vitalo_test` прямо в командной строке и `JOBS_ENABLED=false`; `vitalo-miniapp-testdb` (:5183) и `vitalo-admin-testdb` (:5184) — через `VITALO_API_URL=http://localhost:3100` | `vitalo` / `vitalo_test` | Пароль локальной Docker-базы записан в `launch.json` открытым текстом (`***`; это пароль разработки из `docker-compose.yml`) |
| **Production** | Сервер Ubuntu 24.04 (91.213.99.230). systemd `deploy/systemd/vitalo-api.service`: `node dist/main.js`, `NODE_ENV=production`; `vitalo-bot.service` (tsx). Обновление — `deploy/scripts/update.sh` | База `vitalo` на самом сервере, через unix-сокет с peer-аутентификацией, без пароля (`deploy/api.env.example:11`) | `/opt/vitalo/app/apps/api/.env` на сервере (в git его нет; шаблон — `deploy/api.env.example`) |

Тестовые базы в коде: **только `vitalo_test`**. Существует ли она физически, по коду не проверить («Не подтверждено кодом»); e2e-тесты её используют.

### 8.2 Разделение окружений и риски

| # | Риск | Насколько реальный |
|---|---|---|
| 1 | **Производственная база недоступна с локальной машины по конфигурации:** в репозитории нет ни одного `DATABASE_URL`, указывающего на сервер. На сервере база слушает только сокет, а порт 5432 закрыт в ufw (это настройка сервера из `DEPLOY.md`, а не код). | Защита держится на конфигурации; кодом не проверяется |
| 2 | **Одинаковое имя `vitalo`** у локальной рабочей базы и у базы production; в `CLAUDE.md` «рабочей» названа локальная. | Путаница в инструкциях и командах |
| 3 | **Demo-seed** (`npm run seed`, `prisma/seed.ts`) отказывается работать только при `NODE_ENV=production` (`seed.ts:13-15`). Локальный `.env` содержит `NODE_ENV=development`, поэтому seed **запустится на локальной рабочей базе `vitalo`**; это запрещено только правилом в `CLAUDE.md`. | **Высокий** для локальной рабочей базы |
| 4 | `npm run prisma:migrate` = `prisma migrate dev` по базе из `.env` (локальная `vitalo`). При расхождении схемы и миграций Prisma предлагает сброс базы (интерактивный вопрос). | Средний |
| 5 | **Production: `update.sh` автоматически выполняет `prisma migrate deploy`** при каждом обновлении. Перед этим делается копия базы (`backup.sh db`). Любая миграция в `main` попадает в production при следующем обновлении. | **Высокий** для будущих миграций Operations |
| 6 | Скрипты `staff:add`, `import:products`, `photos:optimize`, `dev:login`, `dev:order-demo`, `bootstrap:prod` берут `DATABASE_URL` из `.env` **без проверки окружения**. На сервере они работают с production (так и задумано для `bootstrap:prod`, `staff:add`, `import:products`; у `dev:*` защиты нет). | Средний |
| 7 | Ничто в коде не мешает выполнить на сервере `prisma migrate reset`. | Требует явной команды |
| 8 | e2e-тесты не могут попасть на рабочую базу: два независимых предохранителя (`setup-env.ts` и проверка `_test` в `global-setup.ts`). | Низкий |

**Вывод:** e2e-тесты от рабочих баз отделены надёжно (доказано кодом). Production отделён от локальной машины только конфигурацией сервера, а не кодом. Локальная рабочая база `vitalo` от seed и `migrate dev` кодом **не защищена**.

---

## 9. Existing Tests

### 9.1 Состав (только чтение, тесты не запускались)

| Группа | Файл (количество `describe`/`it`) | Что проверяет |
|---|---|---|
| Заказы и резерв | `apps/api/test/orders.e2e-spec.ts` (54) | Номер заказа; **резерв на 12 ч** (`:77`); **резерв не трогает `actual`, пишет движение `reserve`** (`:99`); цены считает сервер; `INSUFFICIENT_STOCK` с откатом всех строк (`:185`, `:192`); идемпотентность (`:224-267`); **10 покупателей на 5 штук** (`:278`, `:293`); «Я оплатил(а)» (`:348`); **подтверждение: резерв → списание** (`:372`); двойное подтверждение (`:387`); отмена и освобождение (`:416`); **задача истечения** (`:474`, `:504`) |
| Работа с заказами в админке и склад | `apps/api/test/staff-operations.e2e-spec.ts` (41) | Машина состояний (`:76-103`); правки (`:114-151`); **отмена сотрудником возвращает склад** (`:163`, `:172`); товары (`:193-253`); **склад: приход и партия** (`:267`), **списание не трогает резерв** (`:277`), **пересчёт** (`:286`), **возврат** (`:295`), низкие остатки (`:305`); настройки, сотрудники, журнал, Dashboard |
| Роли | `apps/api/test/staff-roles.e2e-spec.ts` (8), `apps/admin/src/admin.test.tsx` (7: меню по ролям), `apps/api/src/staff/permissions.spec.ts` | Сервер проверяет права; 401/403 |
| Импорт | `apps/api/test/import-products.e2e-spec.ts` (7) | **Остаток задаётся через приход/пересчёт** (`:117`, `:165`) |
| Каталог и корзина | `catalog.e2e-spec.ts` (32: `in_stock`, сортировка в наличии), `cart.e2e-spec.ts` (14: уменьшение до остатка, недоступные строки), `search.e2e-spec.ts` | Доступность = `actual − reserved` |
| Оплаты | В `orders.e2e-spec.ts` (bank/card transfer) и `launch-d.e2e-spec.ts` (напоминание об оплате, `:122`) | — |
| Уведомления | `notifications.e2e-spec.ts` (15) | Очередь, повторы, получатели (admin/manager) |
| Прочее API | `auth`, `addresses`, `delivery`, `favorites`, `bot-internal`, `bootstrap`, `launch-a/b/d` | — |
| Unit | `apps/api/src/**/*.spec.ts` (order-state, order-number, cart-reconcile, category-tree, delivery-quote, permissions, init-data, session-token, stable-json, notification-templates, app.setup) | — |
| Фронтенд и бот | `apps/miniapp/src/*.test.*` (≈22), `apps/admin/src/*.test.*` (8), `apps/bot/src/bot.test.ts` (22) | — |

Тестовые данные склада создаются прямо в `inventory` (`apps/api/test/helpers.ts:71,77,81-82`) и в `prisma/seed.ts`.

### 9.2 Что сломается при переходе на PhysicalUnit/FEFO

Зависит от выбранного смысла `actual_qty` (раздел 16). По коду:

| Тест | Сломается, если… |
|---|---|
| `orders.e2e-spec.ts:372` «подтверждение: резерв → списание» и `:387` | …списание перенесут с оплаты на *SOLD* или изменят количество при оплате |
| `orders.e2e-spec.ts:99` «резерв не трогает `actual`» | …резерв начнёт создавать или назначать единицы |
| `staff-operations.e2e-spec.ts:172` «отмена оплаченного возвращает склад» | …возврат станет поштучным |
| `staff-operations.e2e-spec.ts:267/277/286/295` (приход, списание, пересчёт, возврат) | …приход, списание и пересчёт станут поштучными или потребуют `Purchase`/второго подтверждения |
| `import-products.e2e-spec.ts:117/139/165` | …остаток перестанет задаваться числом |
| `catalog.e2e-spec.ts` (`in_stock`), `cart.e2e-spec.ts:67/99/111`, `staff-operations.e2e-spec.ts:461` (низкие остатки) | …формула «доступно» перестанет быть `actual − reserved` |
| `apps/api/test/helpers.ts` (`createTestProduct`, `setStock`, `stockOf`) | …остаток будет вычисляться из единиц: тогда придётся менять все тесты, которые через эти помощники создают товар с остатком |
| `staff-roles.e2e-spec.ts`, `admin.test.tsx` | …поменяется матрица ролей (например, manager получит `inventory.edit`, warehouse и marketer потеряют `cost_uzs`) |
| `orders.e2e-spec.ts:278/293` (гонка за последней единицей) | Должны остаться без изменений: это регрессия 12-часового резерва из TARGET (§26 Этапа 6) |

---

## 10. Operations Compatibility Matrix

A — уже есть, можно переиспользовать · B — есть, но нужна доработка · C — нет, нужно создать · D — конфликтует с целевой архитектурой

| Область | CURRENT (файлы) | TARGET | Класс | Риск |
|---|---|---|---|---|
| Product/SKU | `products` (`sku` @unique, одна цена, `cost_uzs`, текстовые бренд/производитель/страна/форма), `AdminProductsService`, импорт Excel | Product Master, справочники, цены Yandex/VITALO, комиссия, логистика, одна категория | **B**; категории — **D** | Средний: от товара зависят каталог, корзина, заказы |
| Справочники (Brand, Manufacturer, Country, Form, Unit, Supplier, OzonAccount, ExpenseCategory) | Нет; бренд и прочее — свободный текст | Управляемые справочники с архивированием | **C** | Миграция данных из текста |
| Purchase / PurchaseLine | Нет. Ближе всего — `inventory_batches` (`cost_uzs`, `batch_no`) и `receipt` | Единая закупка Ozon/поставщик, Ожидается/Получено, расхождения, распределение итоговой суммы | **C** | Низкий (новое рядом) |
| Ozon Receiving | Нет | Приёмка по аккаунту Ozon, группы сроков, генерация Physical ID | **C** | Низкий |
| PhysicalUnit / Physical ID | NOT IMPLEMENTED (поиск `physical`, `serial`, `barcode`, `fefo`, `lot`, `code 128` в `apps/*/src` и `schema.prisma` находит только комментарий о «physical delivery» в `schema.prisma:6`) | Центральная сущность склада | **C** | **Высокий**: согласование с `inventory` |
| FEFO | NOT IMPLEMENTED. Срок есть только в `inventory_batches.expiry_date`, нигде не читается | Автовыбор единицы, MISSING и следующая единица | **C** | Высокий |
| Этикетки (XPrinter 365B, Code 128) | NOT IMPLEMENTED | Печать отдельно от приёмки | **C** | Низкий |
| Yandex delivery / sold / return | NOT IMPLEMENTED; канала нет; `orders` не подходит (раздел 4в); бот не разбирает сообщения | Адаптер (Telegram-парсер → позже API) → внутренний Order | **C** (адаптер, статусы); **D** (обязательные поля `orders`) | **Высокий** |
| VITALO delivery | Статусы `paid → picking → handed_to_delivery → in_transit` (`order-state.ts`, `FULFILMENT_STEPS`) | То же + назначение Physical ID после оплаты и сборка со сканированием | **B** | Средний |
| VITALO sold | Статус `delivered` + `delivered_at`; сущности Sale нет; выручка Dashboard считается по `paid_at` (`dashboard.ts:10,38`) | Sale с себестоимостью на момент продажи, только после доставки | **B/C** | Средний |
| VITALO return | Статус `return` недостижим через API; `returns*` — только схема; `POST /staff/inventory/return` без связи с заказом | Return, отдельный от Sale; приёмка конкретной единицы; нельзя принять дважды | **C** (B для enum) | Средний |
| Write-off | `POST /staff/inventory/writeoff`: по количеству, причина обязательна, без второго подтверждения, роль warehouse | Поштучно, второе подтверждение, комментарий не обязателен | **B** | Средний |
| Correction | `POST /staff/inventory/adjustment` (пересчёт), только warehouse/admin, пишется в журнал | Admin/Manager, всегда в Action Log | **B** | Средний |
| Unified stock | `inventory` (товар×склад), один склад, один пул для одного канала | Один склад на оба канала, свободные единицы доступны обоим | **B**; момент списания — **D** (раздел 15) | **Высокий** |
| Reservation (VITALO, 12 ч) | `StockService.reserve/release`, `ReservationExpiryService` | Сохранить без изменений | **A** | — (нужна регрессия) |
| Order / OrderItem | `orders`, `order_items`, машина состояний, журнал правок | Единый Order с `channel`, `externalOrderNumber`, `sourceMetadata`; назначение единицы в строке | **B/D** | Высокий |
| Payments | Ручной перевод на карту или по реквизитам + подтверждение менеджером | Сохранить | **A** | — |
| Expenses | NOT IMPLEMENTED | Ручные расходы Admin, категории, канал | **C** | Низкий |
| Analytics | `DashboardService` (выручка, заказы, топ, низкие остатки), `analytics_events` (воронка), `GET /staff/dashboard/funnel`; `sales_daily` не используется | Продажи, прибыль, каналы, закупки, склад, сроки | **B** (воронку переиспользовать), остальное **C** | Средний |
| Pricing sync | NOT IMPLEMENTED | Две цены, вопрос «поменяли на площадке?», признак «требует синхронизации» | **C** | Низкий |
| Tasks (склад) | `manager_tasks` (`payment_check`, `bank_transfer_check`, `refund`, `other`; `open`/`in_progress`/`done`), экрана задач нет | Задачи RECEIVING/ASSEMBLY/RETURN/LABEL/WRITE_OFF/CORRECTION, OPEN/IN_PROGRESS/COMPLETED/CANCELLED, продолжение работы | **B** (таблица, enum) или **C** | Средний (enum `TaskType`/`TaskStatus` уже используются) |
| Action Log | `audit_logs` + `AuditService.log` в той же транзакции; экран «Журнал» | Все критические переходы | **A** | — |
| Роли и авторизация | `staff_users` + Telegram, `permissions.ts`, `StaffGuard` | Те же 4 роли с другой матрицей | **A** (механизм), **B** (матрица) | Средний |
| Telegram-уведомления | Outbox `notifications` + `NotificationWorker`, тех. чат | Одна общая группа операций; без лишних данных | **B** (сейчас — личные сообщения admin/manager) | Низкий |
| Telegram-парсер Yandex | NOT IMPLEMENTED (бот отвечает «используйте меню») | Первый адаптер Yandex | **C** | Средний (бот один, long polling) |

---

## 11. Migration Risks

| # | Где | Что может сломаться | Чего касается |
|---|---|---|---|
| 1 | `StockService.settle` / `returnDeducted` (`stock.service.ts:88-174`) считают по журналу с `reference_type='order'` и литералам типов | Двойное списание или освобождение, отрицательный резерв | Текущие заказы, 12-часовой резерв |
| 2 | CHECK `inventory_qty_chk` (`reserved ≤ actual`) | Любой смешанный учёт (например, количество поштучно для Yandex) упадёт на ограничении или обойдёт его | Остатки |
| 3 | `deduct` уменьшает `actual_qty` при оплате | Смена момента списания меняет «доступно» в Mini App для всех оплаченных, но не доставленных заказов; по старым заказам уже есть движения `deduct` | Расчёт остатков, исторические данные |
| 4 | Миграция живых остатков: `inventory.actual_qty` > 0 без единиц | Нужно создать начальные PhysicalUnit под существующий остаток (без закупки и без срока) или вести два учёта | Расчёт остатков, production |
| 5 | Уже оплаченные, но не доставленные заказы (`paid`/`picking`/`handed_to_delivery`/`in_transit`) в момент миграции | У них нет назначенных единиц; если сборка начнёт требовать Physical ID — они застрянут | Текущие заказы |
| 6 | Enum `OrderStatus`, `PaymentStatus`, `MovementType`, `TaskType`, `TaskStatus` | Переименование или удаление ломает существующие строки, историю (текст) и код; добавление безопасно | Исторические данные |
| 7 | NOT NULL в `orders` (`user_id`, `region_id`, `city_id`, получатель, суммы) | Ослабление ограничений затронет Mini App, уведомления, endpoint'ы покупателя и Dashboard | Текущий поток |
| 8 | `OrderLifecycleService.addHistory` всегда уведомляет `order.user_id` | Заказы другого канала через тот же путь вызовут ошибки или лишние сообщения | Уведомления |
| 9 | `DashboardService` суммирует все оплаченные `orders` | Смешение каналов изменит выручку и средний чек | Аналитика |
| 10 | `update.sh` автоматически применяет миграции на production | Непроверенная миграция попадёт на живую базу при первом обновлении | Production |
| 11 | Категории: переход с «многие» на «одну» | Потеря второй категории у загруженных товаров, изменение навигации и фильтров Mini App, импорта | Исторические данные, Mini App |
| 12 | `products.cost_uzs` — одна себестоимость на товар | Если перейти на себестоимость единицы, отчёты по прошлым заказам не будут иметь себестоимости (она нигде не фиксировалась) | Исторические данные |
| 13 | Права: `cost_uzs` в `GET /staff/products/:id` | Закрытие для warehouse/marketer изменит API и экран `ProductEdit` | Роли, тесты |
| 14 | Импорт Excel задаёт остаток числом (`product-import.ts:421-426`) | При поштучном учёте импорт не сможет «добавить остаток» без закупки и сроков | Операции |

---

## 12. Reusable Components

| Компонент | Где | Зачем пригодится |
|---|---|---|
| Транзакционный резерв с блокировками | `StockService.reserve/reserveLine` | Шаблон «условный UPDATE + FOR UPDATE + CHECK» для любых атомарных переходов |
| Блокировка заказа и идемпотентные переходы | `OrderLifecycleService.lockOrder`, `cancelUnpaid`/`confirmBankTransfer` (`already_*`) | Подтверждение оплаты, переходы статусов |
| Машина состояний | `order-state.ts` (`ORDER_TRANSITIONS`, `assertTransition`) | Расширяется добавлением значений |
| Идемпотентность запросов | `idempotency_keys` + `OrdersService.create` | Повторные нажатия и повторные вызовы адаптеров |
| Журнал действий | `audit_logs` + `AuditService.log(entry, tx)` | Action Log для всех операций |
| Журнал движений | `inventory_movements` (`reference_type`/`reference_id`, `created_by`) | Совместимость количественного учёта |
| Сотрудники, вход через Telegram, права | `staff_users`, `staff_sessions`, `StaffAuthService`, `StaffGuard`, `@RequirePermission`, `permissions.ts` | Новые права добавляются в одну таблицу |
| Очередь уведомлений и тех. чат | `notifications`, `NotificationWorker`, `SystemErrorsService` | Уведомления операций |
| Задачи менеджера | `manager_tasks` | База для задач (если решите расширять, а не создавать новое) |
| Импорт Excel | `apps/api/src/import/product-import.ts`, `exceljs`, режимы dry-run/confirm | Импорт закупок и справочников |
| Хранилище и обработка фото | `storage/file-storage.ts`, `image-processing.ts` | — |
| Каркас админки | `apps/admin/src/App.tsx`, `Guard`, страницы, общий стиль | Новые разделы в том же интерфейсе |
| Деплой, резервные копии | `deploy/scripts/update.sh`, `backup.sh`, `bootstrap:prod` | Выкатка с копией базы |
| Защита тестовой базы | `test/setup-env.ts`, `test/global-setup.ts` | Тесты Operations |

---

## 13. Required Changes (что придётся изменить; без выбора решения)

1. `StockService.deduct` / `returnDeducted` и связанные места — определить и реализовать смысл `actual_qty` при поштучном учёте (раздел 16, Q1).
2. `OrderLifecycleService.confirmBankTransfer` — шаг назначения единиц после оплаты (TARGET §14 Этапа 6).
3. `orders` / `order_items` — поддержка канала и внешнего номера; назначение нескольких единиц на строку с `qty > 1`.
4. `OrderLifecycleService.addHistory` / `NotificationsService` — уведомления в зависимости от канала.
5. `AdminInventoryService` (приход, списание, пересчёт, возврат) — поштучные операции, второе подтверждение списания, права manager.
6. `permissions.ts` + `toAdminProduct` + `ProductEdit.tsx` + `Inventory.tsx` — скрыть себестоимость и закупочную цену от warehouse/marketer, выручку — от manager/marketer (по TARGET).
7. `products` — цены Yandex/VITALO, комиссия, логистика; справочники вместо текста; категории (по решению).
8. `DashboardService` — разделение по каналам, выручка по продажам.
9. `product-import.ts` — работа с остатком при поштучном учёте.
10. Тесты из раздела 9.2.

---

## 14. Missing Components (NOT IMPLEMENTED)

PhysicalUnit и Physical ID; FEFO и MISSING; Purchase и PurchaseLine; Ozon Receiving и Ozon-аккаунты; поставщики; печать этикеток (Code 128, XPrinter 365B); сканирование; Sale с себестоимостью на момент продажи; Return как процесс (таблицы есть, логики нет); второе подтверждение списания; Expenses и категории расходов; справочники (Brand, Manufacturer, Country, Form, Unit); цены Yandex и синхронизация цен; канал Yandex (адаптер, Telegram-парсер, статусы); экран задач склада; отмена после передачи в доставку (`cancel_requests` не используется); восстановление заказа, отменённого по истечении резерва, если деньги пришли позже; срок ожидания проверки после «Я оплатил(а)»; уведомления в общую группу; контроль сроков годности; пересчёт `popularity_30d`.

---

## 15. Conflicts (CURRENT ↔ TARGET)

| # | CURRENT | TARGET | Суть конфликта |
|---|---|---|---|
| 1 | Списание (`actual_qty −`) при **подтверждении оплаты** (`StockService.deduct`) | Окончательное списание при **YANDEX_SOLD/VITALO_SOLD**; после оплаты единица в «VITALO доставка» | Разный момент выбытия из остатка |
| 2 | У товара **несколько** категорий, два дерева (`product_categories`, `TreeType`) | «Категория у товара одна» | Модель категорий и навигация Mini App |
| 3 | `order_items.qty` может быть > 1 | `OrderItem 0..1 → PhysicalUnit` | Одна строка заказа = несколько единиц |
| 4 | `orders` требует покупателя Telegram, регион/город Узбекистана, адрес, суммы, номер `VTL-…` | Единый Order для Yandex и VITALO, `channel`, `externalOrderNumber` | Обязательные поля и уведомления покупателю |
| 5 | `inventory.available = actual − reserved` — единственный источник «в наличии» для Mini App | Свободные Physical Units — общий пул двух каналов | Два источника правды об остатке |
| 6 | `cost_uzs` видят warehouse/marketer; warehouse вводит закупочную цену | Warehouse и Marketer без себестоимости и закупочной цены | Права |
| 7 | Manager не может менять склад (`inventory.edit` только warehouse) | Manager — полный операционный доступ, включая списания и инвентаризацию | Права |
| 8 | Manager и Marketer видят выручку (`dashboard.view`) | Manager — без финансов; Marketer — только маркетинговая аналитика | Права |
| 9 | Списание делает warehouse без второго подтверждения, причина обязательна | Второе подтверждение, комментарий необязателен | Процесс |
| 10 | Пересчёт (`adjustment`) делает warehouse | Корректировка — Admin/Manager | Права |
| 11 | `manager_tasks`: enum `TaskType` (оплаты и возврат денег) и `TaskStatus` (`open`/`in_progress`/`done`) | Task: RECEIVING/ASSEMBLY/…, OPEN/IN_PROGRESS/COMPLETED/CANCELLED | Набор статусов и типов |
| 12 | Уведомления сотрудникам — личные сообщения admin/manager | Одна общая Telegram-группа операций | Канал уведомлений |

---

## 16. Decisions Required From Me (вопросы с вариантами)

**Q1. Что значит `actual_qty` при поштучном учёте?**
- (a) «Не продано и не отдано»: списание переносится с оплаты на *SOLD*. Меняется `StockService.deduct`, тесты `orders.e2e:372/387`, Dashboard.
- (b) Оставить как сейчас (выбывает при оплате, для VITALO) и для Yandex вычитать при назначении единицы. Количественный учёт сохраняется, но расходится с физическим.
- (c) Количество вычисляется из единиц, а `inventory` становится производной таблицей.

**Q2. Как Mini App узнает о единицах, ушедших в Yandex?**
- (a) Каждое назначение в Yandex меняет `inventory` (как резерв или списание).
- (b) «Доступно» считается из PhysicalUnit.
- (c) Иное.

**Q3. Заказы Yandex:**
- (a) расширить `orders` (канал, внешний номер, ослабить NOT NULL у покупателя и адреса);
- (b) отдельная сущность заказа канала и общий интерфейс;
- (c) иное.

**Q4. Категории:**
- (a) оставить многие-ко-многим и два дерева для Mini App, а в Operations показывать одну «основную»;
- (b) перейти на одну категорию (миграция данных и навигации);
- (c) иное.

**Q5. Строка заказа с `qty > 1`:**
- (a) отдельная таблица назначений «строка ↔ единица»;
- (b) разбивать строки по одной штуке;
- (c) иное.

**Q6. Начальные единицы под текущий остаток production:**
- (a) создать единицы без закупки и с неизвестным сроком;
- (b) провести инвентаризацию с вводом сроков до запуска;
- (c) вести две модели до полной инвентаризации.

**Q7. Отменённый по истечении резерва заказ, деньги за который пришли позже:**
- (a) восстанавливать заказ (новый резерв, если есть остаток);
- (b) только возврат денег;
- (c) создавать новый заказ.

**Q8. Срок ожидания проверки после «Я оплатил(а)»:**
- (a) без срока (как сейчас);
- (b) напоминание менеджеру через N часов;
- (c) иное.

**Q9. Права:**
- скрывать ли `cost_uzs` от warehouse и marketer сразу (до Operations);
- давать ли manager `inventory.edit`;
- оставлять ли marketer выручку на Dashboard.

**Q10. Миграции на production:**
- (a) оставить автоматическое `migrate deploy` в `update.sh`;
- (b) отдельный ручной шаг с подтверждением.

**Q11. Локальная база `vitalo` (рабочая) и production `vitalo`:**
- переименовать ли локальную (например, `vitalo_dev`);
- добавить ли защиту seed по имени базы, а не только по `NODE_ENV`.

**Q12. Задачи склада:**
- (a) расширить `manager_tasks` (новые значения enum);
- (b) отдельная таблица задач.

**Q13. Уведомления операций:**
- одна группа для Yandex и VITALO вместо личных сообщений admin и manager — да или нет;
- оставлять ли личные сообщения.

**Q14. Источник Yandex на первом этапе:**
- какой Telegram-чат или бот присылает заказы Yandex;
- в каком формате.

Без примеров сообщений парсер спроектировать нельзя («Не подтверждено кодом»: таких данных в репозитории нет).

---

## 17. Recommended Next Step

Без реализации и без выбора архитектуры:

1. Ответить на вопросы Q1–Q3 и Q5. Без них нельзя безопасно начинать ни схему PhysicalUnit, ни канал Yandex.
2. Ответить на Q10–Q11 (окружения) до первой миграции Operations. Сейчас любая миграция в `main` автоматически уйдёт на production при обновлении, а локальная рабочая база не защищена от seed кодом.
3. После ответов — согласовать GAP по этапам в порядке Этапа 6 §25 (A → B → C …) и только затем готовить задание для Claude Code по одному этапу.
