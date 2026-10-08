# VITALO — Stage 1 (Architecture + Auth foundation)

## Структура (план монорепо)
apps/api      NestJS API (Prisma, PostgreSQL)
apps/miniapp  React + Vite (Mini App)       — Этап 3
apps/admin    React + Vite (Admin Panel)    — Этап 7
apps/bot      grammY bot                    — Этап 2

## Быстрый запуск на Windows
start.bat — Docker Desktop (запустит и дождётся, при зависании один раз перезапустит) -> postgres+redis ->
окна API (3000), Mini App (5173) и Admin (5174, если есть apps/admin) -> браузер на http://localhost:5173.
stop.bat — закрывает эти окна, освобождает порты 3000/5173/5174, останавливает postgres и redis (данные сохраняются).
Запускать двойным щелчком; из командной строки — `.\start.bat` (просто `start.bat` cmd путает со встроенной командой start).

## Запуск локально
docker compose up -d postgres redis   # образ minio/minio больше не публикуется на Docker Hub
cd apps/api && cp ../../.env.example .env && npm i && npx prisma migrate dev
npm run seed          # 3 региона x 2 города, 2 дерева категорий, 10 БАДов с остатками
# Базы: vitalo_dev — рабочая база этого компьютера, vitalo_test — автотесты, vitalo — только на сервере.
# seed и dev:* работают только с базами *_dev / *_test (иначе отказываются); старую локальную vitalo
# переименовать: powershell -ExecutionPolicy Bypass -File scriptsename-local-db.ps1
npm run start:dev     # API: http://localhost:3000/api, Swagger: http://localhost:3000/api/docs
npm run dev:login     # имитация входа из Telegram (нужен любой TELEGRAM_BOT_TOKEN в .env); -- --staff = менеджер
npm run dev:order-demo  # весь путь: корзина -> заказ -> реквизиты -> «Я оплатил» -> менеджер подтверждает
# constraints.sql уже включён в миграцию prisma/migrations/*_init

## Mini App (apps/miniapp, React + Vite)
cd apps/miniapp && npm i && npm run dev   # http://localhost:5173 (API должен быть запущен: apps/api npm run start:dev)
В обычном браузере открывается «Режим разработки»: выбираете тестового покупателя, dev-сервер Vite
подписывает initData токеном из apps/api/.env (токен не попадает в браузер и в сборку).
В Telegram вход идёт через настоящий Telegram.WebApp.initData. Цвета — из темы Telegram (--tg-theme-*).
npm test (vitest), npm run build (typecheck + сборка в dist/; на хостинге нужен SPA-fallback на index.html)

## Админ-панель (apps/admin, React + Vite, порт 5174)
cd apps/admin && npm i && npm run dev   # http://localhost:5174 (запускается и через start.bat)
Режим разработки: кнопки входа тестовыми сотрудниками из seed — Администратор 222222221, Менеджер 222222222,
Склад 222222223, Маркетолог 222222224. Права (apps/api/src/staff/permissions.ts) проверяет сервер на каждом запросе;
меню лишь скрывает недоступные разделы. Фото товаров: FileStorage (сейчас папка apps/api/uploads, позже S3).
Seed только добавляет недостающее и никогда не перезаписывает существующие товары/остатки.

## Telegram: бот, уведомления, туннель (apps/bot)
Бот @vitalo_store_bot (grammY, long polling): cd apps/bot && npm run dev. Токен берётся только из apps/api/.env.
Меню: Магазин, Мои заказы, Акции, Мой профиль, Поддержка, О VITALO; /start <код> передаёт реферальный код
в Mini App (?startapp= -> start_param при входе); /admin — кнопка админ-панели для сотрудников из staff_users.
Бот читает данные через /api/internal/bot/* с заголовком X-Bot-Secret = BOT_API_SECRET (из apps/api/.env).
Уведомления: очередь notifications (outbox, в одной транзакции с изменением заказа), отправка каждые 3 с,
до 5 попыток (30с, 2м, 10м, 30м), 429 — ждём retry_after, 400/403 — без повторов; все ошибки в system_errors.
Клиенту: оплачен, передан в доставку, в пути, доставлен, отменён (RU/UZ); админам и менеджерам: новый заказ, «Я оплатил».
Маркетинговые сообщения уходят только при users.marketing_opt_in (переключатель в профиле Mini App).
Туннель для телефона: winget install --id Cloudflare.cloudflared, затем npm run tunnel (или start.bat) —
два адреса https://*.trycloudflare.com (Mini App и админка), кнопка меню бота обновляется автоматически.
start.bat ждёт адреса до 90 с и печатает их в своём окне. Если адреса сменились (сравнение с
.runtime/notified-urls.json), активные admin и manager получают в боте «Новые адреса VITALO» с кнопками
«Открыть админку» и «Открыть магазин»; клиентам такое сообщение не уходит никогда.
Сотрудник: npm run staff:add -- --telegram-id <id> --name "Имя" --role admin (apps/api).
DEV-вход: только NODE_ENV=development, только с localhost (через туннель — 404), в рабочей сборке отсутствует (тест).
CORS: CORS_ORIGINS (через запятую); пусто — localhost-серверы разработки, в production — никто.

## Тесты
npm test              # unit
npm run test:e2e      # API + реальная БД vitalo_test (создаётся, очищается и заполняется seed автоматически)

## API (MVP)
POST /api/auth/telegram {initData} -> {token, expires_at, is_new_user, user}; в БД хранится только sha256(token)
GET  /api/auth/me, POST /api/auth/logout   (Authorization: Bearer <token>)
GET  /api/catalog/categories              -> {need: [...], product_type: [...]}
GET  /api/catalog/brands
GET  /api/catalog/products?category=&brand=A,B&price_min=&price_max=&in_stock=&sort=popular|price_asc|price_desc|new&page=
     (товары без остатка всегда в конце списка)
GET  /api/catalog/products/:id
GET  /api/catalog/search?q=&page=          (pg_trgm + vitalo_norm(): транслитерация ru/uz/en, "kolagen" -> Коллаген)

GET  /api/delivery/regions, GET /api/delivery/quote?region_id&city_id&goods_total_uzs
GET  /api/cart[?region_id&city_id]          — при каждом открытии сверяет цену/остаток, warnings[]
POST /api/cart/items {product_id, qty}, PATCH /api/cart/items/:productId {qty}, DELETE /api/cart/items/:productId
GET  /api/cart/count                        — счётчик для бейджа (не «съедает» предупреждения корзины)
GET/PUT/DELETE /api/favorites[/:productId], GET /api/favorites/ids
GET/POST /api/addresses, PATCH/DELETE /api/addresses/:id, POST /api/addresses/:id/primary (один основной)
PATCH /api/auth/me {language}; GET /api/catalog/forms; фильтр ?form= в /catalog/products
POST /api/orders/preview                    — расчёт для экрана подтверждения, без резерва
POST /api/orders  (header Idempotency-Key)  — source=cart|buy_now; резерв атомарный; VTL-YYYYMMDD-NNNN
GET  /api/orders, GET /api/orders/:id, GET /api/orders/checkout-defaults, POST /api/orders/:id/cancel
GET  /api/orders/:id/payment/bank-transfer, POST /api/orders/:id/payment/bank-transfer/paid («Я оплатил»)
POST /api/staff/auth/telegram; GET /api/staff/orders[?awaiting_confirmation=true]; POST /api/staff/orders/:id/confirm-payment
Фоновая задача (каждую минуту): отмена неоплаченных заказов с истёкшим резервом (JOBS_ENABLED=false — выключить)

## Решения по ТЗ (нужно подтвердить)
1. Убрал orders.delivery_status — дублирует orders.status. Добавил shipments для объединения заказов в одну доставку.
2. inventory.available_qty не хранится: actual - reserved (view + CHECK).
3. Добавлены: settings (бонус %, реферал, мин. сумма для бонусов, контакт поддержки),
   cancel_requests, manager_tasks (fallback при отсутствии webhook), notifications, return_media.
4. bonus_ledger.idempotency_ref (unique) — защита от двойного начисления при повторном webhook.
5. Оплата 100% бонусами при платной доставке: заказ НЕ Paid, пока не оплачена доставка (как в Flow §16);
   в Master ТЗ §10 сказано иначе — приоритет Master ТЗ, нужно уточнить.
6. Staff-вход: Telegram initData того же бота, затем проверка telegram_user_id в staff_users.
7. Оформление из корзины берёт только доступные позиции; недоступные остаются в корзине (ТЗ §6).
8. Если клиент нажал «Я оплатил», автоотмена по истечении резерва НЕ срабатывает — решает менеджер
   (деньги могут быть уже в пути). «Я оплатил» после истечения срока не принимается.
9. Позиция заказа резервируется в одном складе (сейчас склад один). Доставка V1 — 'courier' для всех городов.
