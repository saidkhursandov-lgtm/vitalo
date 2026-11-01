-- Stage 3.3: one discount calculation and promo codes on top of the existing (empty) promotions tables.
-- Only ADDS things (rules for the production database): an enum value, nullable/defaulted columns, indexes, a foreign key.
ALTER TYPE "PromoType" ADD VALUE IF NOT EXISTS 'free_delivery';

ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "description_ru" TEXT;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "description_uz" TEXT;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "first_order_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "promotion_targets" ADD COLUMN IF NOT EXISTS "brand_id" UUID;
CREATE INDEX IF NOT EXISTS "promotion_targets_promotion_id_idx" ON "promotion_targets"("promotion_id");
DO $$ BEGIN
  ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "promotion_usages_order_id_key" ON "promotion_usages"("order_id");

ALTER TABLE "carts" ADD COLUMN IF NOT EXISTS "promo_code" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promo_code" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pricing_json" JSONB;
