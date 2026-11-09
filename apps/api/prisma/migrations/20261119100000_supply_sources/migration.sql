-- D-61, ветка supply-sources: products by supplier; «под заказ» from any supplier (generalises D-60 «из США»).
-- Only additions: new columns with defaults / nullable, one new table, rows added with ON CONFLICT / WHERE NOT EXISTS.
-- Nothing is ever deleted or renamed; products.cross_border_eligible stays (no longer read by the code).

-- Supplier kinds: ozon (bought on Ozon, sold from stock) | local (Uzbekistan) | foreign (abroad, prepayment only).
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "code" TEXT;            -- ozon | iherb: the suppliers the code knows
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "from_ru" TEXT;         -- «из США» (foreign): «Под заказ из США»
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "from_uz" TEXT;         -- «AQShdan»
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "days_min" INTEGER;     -- «под заказ» term from the payment, days
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "days_max" INTEGER;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "guarantee_days" INTEGER; -- then the customer may cancel with a refund
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "sort" INTEGER NOT NULL DEFAULT 100; -- order of the tabs
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_code_key" ON "suppliers" ("code");

-- Where a product is bought (several suppliers possible), with the supplier's own code or link.
CREATE TABLE IF NOT EXISTS "product_suppliers" (
  "product_id"   UUID         NOT NULL,
  "supplier_id"  UUID         NOT NULL,
  "supplier_sku" TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_suppliers_pkey" PRIMARY KEY ("product_id", "supplier_id")
);
CREATE INDEX IF NOT EXISTS "product_suppliers_supplier_idx" ON "product_suppliers" ("supplier_id");
DO $$ BEGIN
  ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- «Если на складе ноль»: null = «Нет в наличии» (waiting list), otherwise «под заказ» from this supplier (the owner chooses).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "on_zero_supplier_id" UUID;
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_on_zero_supplier_id_fkey" FOREIGN KEY ("on_zero_supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The supplier of a «под заказ» line and of a parcel.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "supplier_id" UUID;
ALTER TABLE "cross_border_batches" ADD COLUMN IF NOT EXISTS "supplier_id" UUID;
DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cross_border_batches" ADD CONSTRAINT "cross_border_batches_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ───── The suppliers the shop has today ─────
INSERT INTO "suppliers" ("id", "name", "code", "kind", "sort", "updated_at")
SELECT gen_random_uuid(), 'Ozon', 'ozon', 'ozon', 10, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "suppliers" WHERE "code" = 'ozon');

-- iHerb takes the «из США» terms from the D-60 settings (7–14 days, guarantee 21 when they were never changed).
INSERT INTO "suppliers" ("id", "name", "code", "kind", "from_ru", "from_uz", "days_min", "days_max", "guarantee_days", "sort", "updated_at")
SELECT gen_random_uuid(), 'iHerb', 'iherb', 'foreign', 'из США', 'AQShdan',
       COALESCE((SELECT ("value"->>'days_min')::int FROM "settings" WHERE "key" = 'cross_border'), 7),
       COALESCE((SELECT ("value"->>'days_max')::int FROM "settings" WHERE "key" = 'cross_border'), 14),
       COALESCE((SELECT ("value"->>'guarantee_days')::int FROM "settings" WHERE "key" = 'cross_border'), 21),
       20, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "suppliers" WHERE "code" = 'iherb');

-- Glorious Healthy Nutrition MChJ: local, «под заказ • 1–2 дня» (added when the dictionary does not have it yet).
INSERT INTO "suppliers" ("id", "name", "kind", "sort", "updated_at")
SELECT gen_random_uuid(), 'Glorious Healthy Nutrition', 'local', 30, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "suppliers" WHERE "name" ILIKE 'glorious%');
UPDATE "suppliers" SET "days_min" = COALESCE("days_min", 1), "days_max" = COALESCE("days_max", 2), "guarantee_days" = COALESCE("guarantee_days", 7),
       "sort" = LEAST("sort", 30)
WHERE "name" ILIKE 'glorious%' AND "kind" = 'local';

-- ───── Where products come from today ─────
-- iHerb: an iHerb link, the D-60 checkbox or the owner's SKU (VTL-H001…, VTL-GH001…)
INSERT INTO "product_suppliers" ("product_id", "supplier_id")
SELECT p."id", s."id" FROM "products" p, "suppliers" s
WHERE s."code" = 'iherb' AND (p."iherb_url" IS NOT NULL OR p."cross_border_eligible" OR p."sku" ~* '^VTL-G?H[0-9]')
ON CONFLICT DO NOTHING;
-- Glorious: VTL-GH001… (also in their list)
INSERT INTO "product_suppliers" ("product_id", "supplier_id")
SELECT p."id", s."id" FROM "products" p, (SELECT "id" FROM "suppliers" WHERE "name" ILIKE 'glorious%' ORDER BY "created_at" LIMIT 1) s
WHERE p."sku" ~* '^VTL-GH[0-9]'
ON CONFLICT DO NOTHING;
-- Ozon: bought on Ozon (a purchase line) or the Ozon catalogue SKU OZN-…
INSERT INTO "product_suppliers" ("product_id", "supplier_id")
SELECT DISTINCT p."id", s."id" FROM "products" p, "suppliers" s
WHERE s."code" = 'ozon' AND (p."sku" ILIKE 'OZN-%' OR EXISTS (
  SELECT 1 FROM "purchase_lines" l JOIN "purchases" pu ON pu."id" = l."purchase_id" WHERE l."product_id" = p."id" AND pu."source_type" = 'OZON'))
ON CONFLICT DO NOTHING;
-- Other suppliers: their purchases
INSERT INTO "product_suppliers" ("product_id", "supplier_id")
SELECT DISTINCT l."product_id", pu."supplier_id" FROM "purchase_lines" l JOIN "purchases" pu ON pu."id" = l."purchase_id"
WHERE pu."source_type" = 'SUPPLIER' AND pu."supplier_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- What sold «из США» before keeps doing so: «если ноль — под заказ у iHerb».
UPDATE "products" p SET "on_zero_supplier_id" = s."id"
FROM "suppliers" s
WHERE s."code" = 'iherb' AND p."on_zero_supplier_id" IS NULL AND (p."cross_border_eligible" OR p."sku" ~* '^VTL-G?H[0-9]');

-- The lines and parcels «из США» made before this change are iHerb's.
UPDATE "order_items" SET "supplier_id" = (SELECT "id" FROM "suppliers" WHERE "code" = 'iherb')
WHERE "source" = 'cross_border' AND "supplier_id" IS NULL;
UPDATE "cross_border_batches" SET "supplier_id" = (SELECT "id" FROM "suppliers" WHERE "code" = 'iherb')
WHERE "supplier_id" IS NULL;
