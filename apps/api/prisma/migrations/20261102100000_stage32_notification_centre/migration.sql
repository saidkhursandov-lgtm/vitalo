-- Stage 3.2: notification centre in the Mini App on top of the existing notifications queue.
-- Only ADDS things (rules for the production database): new nullable columns, indexes, a foreign key.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "order_id" UUID;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "product_id" UUID;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "dedup_key" TEXT;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedup_key_key" ON "notifications"("dedup_key");
CREATE INDEX IF NOT EXISTS "notifications_order_id_created_at_idx" ON "notifications"("order_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
