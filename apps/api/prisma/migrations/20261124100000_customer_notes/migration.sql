-- Аудит админки 10.11, п. 4.1: заметки сотрудников о клиенте в карточке клиента.
-- Только добавляющая: новая таблица; существующие данные не меняются. Заметки не удаляются (как и журнал аудита).
CREATE TABLE IF NOT EXISTS "customer_notes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "customer_notes_user_id_created_at_idx" ON "customer_notes"("user_id", "created_at");
DO $$ BEGIN
    ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
