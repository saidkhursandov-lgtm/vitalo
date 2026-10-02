# VITALO — Stage 1 (Architecture + Auth foundation)

## Структура (план монорепо)
apps/api      NestJS API (Prisma, PostgreSQL)
apps/miniapp  React + Vite (Mini App)       — Этап 3
apps/admin    React + Vite (Admin Panel)    — Этап 7
apps/bot      grammY bot                    — Этап 2

## Запуск локально
docker compose up -d postgres redis   # образ minio/minio больше не публикуется на Docker Hub
cd apps/api && cp ../../.env.example .env && npm i && npx prisma migrate dev
npm run seed          # 3 региона x 2 города, 2 дерева категорий, 10 БАДов с остатками
npm run start:dev     # API: http://localhost:3000/api, Swagger: http://localhost:3000/api/docs
npm run dev:login     # имитация входа из Telegram (нужен любой TELEGRAM_BOT_TOKEN в .env)
# constraints.sql уже включён в миграцию prisma/migrations/*_init

## Тесты
npm test              # unit
npm run test:e2e      # API + реальная БД vitalo_test (создаётся, очищается и заполняется seed автоматически)

## API (MVP)
POST /api/auth/telegram {initData} -> {token, expires_at, is_new_user, user}; в БД хранится только sha256(token)
GET  /api/auth/me, POST /api/auth/logout   (Authorization: Bearer <token>)
GET  /api/catalog/categories              -> {need: [...], product_type: [...]}
GET  /api/catalog/brands
GET  /api/catalog/products?category=&brand=A,B&price_min=&price_max=&sort=popular|price_asc|price_desc|new&page=
GET  /api/catalog/products/:id
GET  /api/catalog/search?q=&page=          (pg_trgm + vitalo_norm(): транслитерация ru/uz/en, "kolagen" -> Коллаген)

## Решения по ТЗ (нужно подтвердить)
1. Убрал orders.delivery_status — дублирует orders.status. Добавил shipments для объединения заказов в одну доставку.
2. inventory.available_qty не хранится: actual - reserved (view + CHECK).
3. Добавлены: settings (бонус %, реферал, мин. сумма для бонусов, контакт поддержки),
   cancel_requests, manager_tasks (fallback при отсутствии webhook), notifications, return_media.
4. bonus_ledger.idempotency_ref (unique) — защита от двойного начисления при повторном webhook.
5. Оплата 100% бонусами при платной доставке: заказ НЕ Paid, пока не оплачена доставка (как в Flow §16);
   в Master ТЗ §10 сказано иначе — приоритет Master ТЗ, нужно уточнить.
6. Staff-вход: Telegram initData того же бота, затем проверка telegram_user_id в staff_users.
