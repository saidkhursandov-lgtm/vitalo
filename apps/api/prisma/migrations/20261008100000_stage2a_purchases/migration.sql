-- Stage 2A: purchases (Ozon and suppliers). Only adds: enums, tables, indexes, constraints, triggers and
-- the starting dictionary values (Ozon accounts and one supplier) when they are missing.
-- Stock, orders and products are not touched.

-- CreateEnum
CREATE TYPE "PurchaseSourceType" AS ENUM ('OZON', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('EXPECTED', 'RECEIVED');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ozon_accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ozon_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "source_type" "PurchaseSourceType" NOT NULL,
    "ozon_account_id" UUID,
    "supplier_id" UUID,
    "ozon_order_number" TEXT,
    "purchase_date" DATE NOT NULL,
    "final_actual_total_uzs" BIGINT,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'EXPECTED',
    "comment" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_lines" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "ordered_qty" INTEGER NOT NULL,
    "cancelled_qty" INTEGER NOT NULL DEFAULT 0,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "unit_price_original_uzs" BIGINT NOT NULL,
    "allocated_total_uzs" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_events" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "purchase_line_id" UUID,
    "type" TEXT NOT NULL,
    "qty" INTEGER,
    "before_json" JSONB,
    "after_json" JSONB,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchases_source_type_purchase_date_idx" ON "purchases"("source_type", "purchase_date");

-- CreateIndex
CREATE INDEX "purchases_ozon_account_id_ozon_order_number_idx" ON "purchases"("ozon_account_id", "ozon_order_number");

-- CreateIndex
CREATE INDEX "purchases_supplier_id_idx" ON "purchases"("supplier_id");

-- CreateIndex
CREATE INDEX "purchase_lines_product_id_idx" ON "purchase_lines"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_lines_purchase_id_product_id_key" ON "purchase_lines"("purchase_id", "product_id");

-- CreateIndex
CREATE INDEX "purchase_events_purchase_id_created_at_idx" ON "purchase_events"("purchase_id", "created_at");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_ozon_account_id_fkey" FOREIGN KEY ("ozon_account_id") REFERENCES "ozon_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_events" ADD CONSTRAINT "purchase_events_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_events" ADD CONSTRAINT "purchase_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────── rules Prisma cannot express ─────────────

-- Names unique ignoring case and extra spaces (like the stage 1 dictionaries)
CREATE UNIQUE INDEX "suppliers_name_norm_key" ON "suppliers" (lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));
CREATE UNIQUE INDEX "ozon_accounts_name_norm_key" ON "ozon_accounts" (lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));

-- Never deleted, only archived (function from the stage 1 migration)
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON "suppliers" FOR EACH ROW EXECUTE FUNCTION forbid_dictionary_delete();
CREATE TRIGGER ozon_accounts_no_delete BEFORE DELETE ON "ozon_accounts" FOR EACH ROW EXECUTE FUNCTION forbid_dictionary_delete();

-- A purchase is never deleted (cancellation is an event)
CREATE OR REPLACE FUNCTION forbid_purchase_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'purchases cannot be deleted; cancel the quantities instead';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER purchases_no_delete BEFORE DELETE ON "purchases" FOR EACH ROW EXECUTE FUNCTION forbid_purchase_delete();

-- The purchase history is append-only (like bonus_ledger)
CREATE OR REPLACE FUNCTION forbid_purchase_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'purchase_events is append-only';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_events_immutable BEFORE UPDATE OR DELETE ON "purchase_events" FOR EACH ROW EXECUTE FUNCTION forbid_purchase_event_mutation();

-- OZON: account + order number; SUPPLIER: supplier (and no Ozon fields)
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_source_chk" CHECK (
  (source_type = 'OZON' AND ozon_account_id IS NOT NULL AND ozon_order_number IS NOT NULL AND btrim(ozon_order_number) <> '' AND supplier_id IS NULL)
  OR (source_type = 'SUPPLIER' AND supplier_id IS NOT NULL AND ozon_account_id IS NULL AND ozon_order_number IS NULL)
);
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_final_total_chk" CHECK (final_actual_total_uzs IS NULL OR final_actual_total_uzs >= 0);
-- One Ozon order number per account (case and spaces ignored)
CREATE UNIQUE INDEX "purchases_ozon_order_key" ON "purchases" ("ozon_account_id", lower(btrim("ozon_order_number")))
  WHERE "ozon_account_id" IS NOT NULL AND "ozon_order_number" IS NOT NULL;

ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_qty_chk" CHECK (
  ordered_qty > 0 AND cancelled_qty >= 0 AND cancelled_qty <= ordered_qty AND received_qty >= 0
  AND unit_price_original_uzs >= 0 AND (allocated_total_uzs IS NULL OR allocated_total_uzs >= 0)
);

-- ───────────── starting values (add if missing) ─────────────
INSERT INTO "ozon_accounts" ("id", "name", "status", "created_at", "updated_at")
SELECT gen_random_uuid(), v.name, 'active', now(), now()
FROM (VALUES ('Сиадкомол'), ('Хадича'), ('Сиирожиддин'), ('Мастура'), ('Ислом')) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "ozon_accounts" a WHERE lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g')) = lower(v.name)
);

INSERT INTO "suppliers" ("id", "name", "status", "created_at", "updated_at")
SELECT gen_random_uuid(), 'Glorious Health Nutrition', 'active', now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "suppliers" s WHERE lower(regexp_replace(btrim(s.name), '\s+', ' ', 'g')) = 'glorious health nutrition'
);
