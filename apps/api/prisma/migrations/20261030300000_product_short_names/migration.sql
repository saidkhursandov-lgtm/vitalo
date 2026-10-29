-- Short product names: the columns already exist since 20261029200000_stage21_short_name_online_payments.
-- Kept as a no-op safety net (IF NOT EXISTS) because it is already recorded on vitalo_dev; changes nothing.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name_uz" TEXT;
