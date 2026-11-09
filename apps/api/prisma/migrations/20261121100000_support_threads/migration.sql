-- 6а-Д (D-62): «Спросить специалиста» inside the Mini App — a customer's question and the conversation with the shop.
-- Additive only: two new tables.
CREATE TABLE IF NOT EXISTS "support_threads" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "topic" TEXT NOT NULL,
  "product_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'open',
  "lang" TEXT NOT NULL DEFAULT 'ru',
  "customer_unread" INTEGER NOT NULL DEFAULT 0,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_threads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "support_threads_user_id_idx" ON "support_threads"("user_id");
CREATE INDEX IF NOT EXISTS "support_threads_status_last_message_at_idx" ON "support_threads"("status", "last_message_at");

CREATE TABLE IF NOT EXISTS "support_messages" (
  "id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "author" TEXT NOT NULL,
  "staff_user_id" UUID,
  "text" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "support_messages_thread_id_created_at_idx" ON "support_messages"("thread_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "support_threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
