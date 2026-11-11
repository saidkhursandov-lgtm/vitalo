-- Аудит админки 10.11, п. 1.5: отметка «тестовый» у товаров, брендов, закупок и клиентов (как уже есть у заказов).
-- Только добавляющая: новые колонки со значением по умолчанию false; существующие записи не меняются —
-- какие из них тестовые, владелец отмечает сам в админке (вопрос 128).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "purchases" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT false;
