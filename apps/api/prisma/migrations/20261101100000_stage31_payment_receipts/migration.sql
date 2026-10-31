-- Stage 3.1: receipts customers send to the bot for a card transfer. Only ADDS things (rules for the production database).
CREATE TABLE IF NOT EXISTS "payment_receipts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "telegram_file_unique_id" TEXT NOT NULL,
    "telegram_file_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reject_reason" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_receipts_order_id_telegram_file_unique_id_key" ON "payment_receipts"("order_id", "telegram_file_unique_id");
CREATE INDEX IF NOT EXISTS "payment_receipts_order_id_created_at_idx" ON "payment_receipts"("order_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
