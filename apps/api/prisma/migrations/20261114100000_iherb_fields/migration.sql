-- Генплан, этап 5, ветка iherb-1-fields (D-57): iHerb settings of a product and the fields of the «1-в-1» match.
-- Only additions: nothing is renamed or removed; existing products keep working as before (all off / empty).

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "iherb_url" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "iherb_product_id" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cross_border_eligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "auto_pricing_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "markup_percent" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "price_round_to" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stock_price_mode" TEXT NOT NULL DEFAULT 'freeze';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dose_amount" DECIMAL(12,3);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dose_unit" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dose_per" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "match_form" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "products_iherb_product_id_key" ON "products"("iherb_product_id");
CREATE INDEX IF NOT EXISTS "products_cross_border_eligible_idx" ON "products"("cross_border_eligible") WHERE "cross_border_eligible";
