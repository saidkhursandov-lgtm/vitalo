-- Stage 2.2: three-layer catalog and the brand showcase. Only ADDS things (rules for the production database).
-- Moving products to the new categories is a separate step: npm run catalog:stage22 (dry run first, backup, rollback).

-- Brands: the existing dictionary gets a clean address, a logo, a country and the «Почему [бренд] в VITALO» text.
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "logo_url" TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "country_ru" TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "country_uz" TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "why_vitalo_ru" TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "why_vitalo_uz" TEXT;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "show_in_showcase" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS "brands_slug_key" ON "brands"("slug");

-- Addresses for the brands already there: «NOW Foods» -> now-foods; a non-Latin or repeated name gets a piece of its id.
UPDATE "brands" b SET "slug" = s."slug"
FROM (
  SELECT "id",
    CASE
      WHEN base = '' THEN 'brand-' || substr("id"::text, 1, 8)
      WHEN row_number() OVER (PARTITION BY base ORDER BY "created_at", "id") > 1 THEN base || '-' || substr("id"::text, 1, 4)
      ELSE base
    END AS "slug"
  FROM (
    SELECT "id", "created_at", trim(both '-' from regexp_replace(lower("name_ru"), '[^a-z0-9]+', '-', 'g')) AS base
    FROM "brands"
  ) t
) s
WHERE b."id" = s."id" AND b."slug" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "brands" x WHERE x."slug" = s."slug");

-- Country of the brand: filled once where all its products have the same country (editable in Админка → Бренды).
UPDATE "brands" b SET "country_ru" = c."name_ru", "country_uz" = c."name_uz"
FROM (
  SELECT p."brand_id", min(p."country_id"::text)::uuid AS country_id
  FROM "products" p
  WHERE p."brand_id" IS NOT NULL AND p."country_id" IS NOT NULL
  GROUP BY p."brand_id"
  HAVING count(DISTINCT p."country_id") = 1
) one
JOIN "countries" c ON c."id" = one.country_id
WHERE b."id" = one."brand_id" AND b."country_ru" IS NULL AND b."country_uz" IS NULL;

-- Categories: an old (hidden) category may point to the one that replaced it, so old links and banners keep working.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "merged_into_id" UUID;
DO $$ BEGIN
  ALTER TABLE "categories" ADD CONSTRAINT "categories_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Two new product types (empty until the move; customers never see empty categories).
INSERT INTO "categories" ("id", "parent_id", "tree_type", "name_ru", "name_uz", "slug", "sort_order", "status") VALUES
  (gen_random_uuid(), NULL, 'product_type', 'Креатин и аминокислоты', 'Kreatin va aminokislotalar', 'creatine-amino', 55, 'active'),
  (gen_random_uuid(), NULL, 'product_type', 'Протеин и гейнеры', 'Protein va geynerlar', 'protein', 57, 'active')
ON CONFLICT ("slug") DO NOTHING;
