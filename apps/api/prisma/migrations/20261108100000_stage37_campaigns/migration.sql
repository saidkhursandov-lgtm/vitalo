-- Stage 3.7: sales («Акции») and promo skins on top of the promotions tables of 3.3 (one discount module, D-39).
-- Only ADDS things (rules for the production database): two enums, nullable/defaulted columns, indexes.
DO $$ BEGIN
  CREATE TYPE "PromotionKind" AS ENUM ('code', 'campaign');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "CampaignSkin" AS ENUM ('none', 'black_friday', 'eleven_eleven', 'sale');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "kind" "PromotionKind" NOT NULL DEFAULT 'code';
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "title_ru" TEXT;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "title_uz" TEXT;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "skin" "CampaignSkin";
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "open_ended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "notify_start" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "start_notified_at" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "promotions_slug_key" ON "promotions"("slug");
CREATE INDEX IF NOT EXISTS "promotions_kind_status_start_at_idx" ON "promotions"("kind", "status", "start_at");

ALTER TABLE "promotion_targets" ADD COLUMN IF NOT EXISTS "discount_pct" INTEGER;
ALTER TABLE "promotion_targets" ADD COLUMN IF NOT EXISTS "campaign_price_uzs" BIGINT;
CREATE INDEX IF NOT EXISTS "promotion_targets_product_id_idx" ON "promotion_targets"("product_id");

ALTER TABLE "cart_items" ADD COLUMN IF NOT EXISTS "campaign_id" UUID;
