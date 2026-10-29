-- Short product names (up to 40 chars) from the content sheet: catalog cards and the product page (2.2 / 2.3).
-- Additive only.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name_uz" TEXT;
