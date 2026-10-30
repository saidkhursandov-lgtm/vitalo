-- 2.3: product card fields. Additive only.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "substance_form_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "substance_form_uz" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pack_count" INTEGER;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "servings_per_day" INTEGER;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "std_bioavailability" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "std_tested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "std_original" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "halal_vege" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "shell_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "shell_uz" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "halal_vege_source" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "market_advantage_percent" INTEGER;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "doctor_verdict_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "doctor_verdict_uz" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "intake_memo_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "intake_memo_uz" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "admin_note" TEXT;
