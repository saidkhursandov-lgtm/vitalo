-- VITALO AI, ветка 1 «карточка как одно окно». Additive only: new columns, one new table, a backfill of empty new columns.

-- dose of a substance per serving (from the label); units as products.dose_unit: mg | mcg | iu | g | ml | cfu_bn
ALTER TABLE "product_substances" ADD COLUMN IF NOT EXISTS "dose_amount" DECIMAL(12,3);
ALTER TABLE "product_substances" ADD COLUMN IF NOT EXISTS "dose_unit" TEXT;

-- who the product is for and the health goals it is about
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "audience" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "goals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- «Когда принимать» split into the time of day and the meal
ALTER TABLE "compat_rules" ADD COLUMN IF NOT EXISTS "time_a" TEXT;
ALTER TABLE "compat_rules" ADD COLUMN IF NOT EXISTS "time_b" TEXT;
ALTER TABLE "compat_rules" ADD COLUMN IF NOT EXISTS "meal_a" TEXT;
ALTER TABLE "compat_rules" ADD COLUMN IF NOT EXISTS "meal_b" TEXT;

UPDATE "compat_rules" SET
  "time_a" = CASE WHEN "when_a" IN ('morning', 'day', 'evening') THEN "when_a" END,
  "meal_a" = CASE WHEN "when_a" IN ('with_food', 'empty_stomach') THEN "when_a" END
WHERE "when_a" IS NOT NULL AND "time_a" IS NULL AND "meal_a" IS NULL;
UPDATE "compat_rules" SET
  "time_b" = CASE WHEN "when_b" IN ('morning', 'day', 'evening') THEN "when_b" END,
  "meal_b" = CASE WHEN "when_b" IN ('with_food', 'empty_stomach') THEN "when_b" END
WHERE "when_b" IS NOT NULL AND "time_b" IS NULL AND "meal_b" IS NULL;

-- drafts of VITALO AI for a product card: a person accepts or rejects them
CREATE TABLE IF NOT EXISTS "product_enrichments" (
  "id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payload" JSONB NOT NULL,
  "model" TEXT NOT NULL,
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "created_by" UUID,
  "decided_by" UUID,
  "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_enrichments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "product_enrichments_product_id_status_idx" ON "product_enrichments"("product_id", "status");
CREATE INDEX IF NOT EXISTS "product_enrichments_status_idx" ON "product_enrichments"("status");
DO $$ BEGIN
  ALTER TABLE "product_enrichments" ADD CONSTRAINT "product_enrichments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
