-- D-79 «Фасовки»: one product in several pack sizes / doses. Each pack size stays a product of its own (SKU, stock, price,
-- iHerb number); products with the same variant_group_id are shown as «Фасовка» buttons on each other's card.
-- Only new nullable columns and an index.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "variant_group_id" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "variant_label_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "variant_label_uz" TEXT;
CREATE INDEX IF NOT EXISTS "products_variant_group_id_idx" ON "products"("variant_group_id");
