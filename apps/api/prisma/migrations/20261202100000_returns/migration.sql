-- 3.10-В: returns on the customer's request. Additive only: new columns with defaults and indexes on the existing,
-- still unused tables returns / return_items / return_media (return_media.url keeps the private file key until a
-- photo is needed elsewhere: return photos are never public).
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "full_order" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "rejected_by" UUID;
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "rejected_at" TIMESTAMP(3);
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "refunded_by" UUID;
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "refund_method" TEXT;
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "bonus_reversed_uzs" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "returns" ADD COLUMN IF NOT EXISTS "bonus_returned_uzs" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "return_media" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "returns_order_id_idx" ON "returns"("order_id");
CREATE INDEX IF NOT EXISTS "returns_status_created_at_idx" ON "returns"("status", "created_at");
CREATE INDEX IF NOT EXISTS "return_items_return_id_idx" ON "return_items"("return_id");
CREATE INDEX IF NOT EXISTS "return_media_return_id_idx" ON "return_media"("return_id");
