-- Stage 1: dictionaries (brands, manufacturers, countries, forms) and Yandex Market fields of a product.
-- Only adds: new tables, nullable columns (plus one boolean with default false), indexes and constraints.
-- Existing rows are not changed: the text columns brand / manufacturer / country / form stay as they are
-- (the *_id links are filled later by `npm run backfill:dictionaries`).

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "brand_id" UUID,
ADD COLUMN     "country_id" UUID,
ADD COLUMN     "form_id" UUID,
ADD COLUMN     "manufacturer_id" UUID,
ADD COLUMN     "yandex_commission_percent" DECIMAL(5,2),
ADD COLUMN     "yandex_logistics_uzs" BIGINT,
ADD COLUMN     "yandex_payment_fee_percent" DECIMAL(5,2),
ADD COLUMN     "yandex_price_sync_changed_at" TIMESTAMP(3),
ADD COLUMN     "yandex_price_sync_needed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "yandex_price_uzs" BIGINT;

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturers" (
    "id" UUID NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "countries" (
    "id" UUID NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" UUID NOT NULL,
    "name_ru" TEXT NOT NULL,
    "name_uz" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");

-- CreateIndex
CREATE INDEX "products_manufacturer_id_idx" ON "products"("manufacturer_id");

-- CreateIndex
CREATE INDEX "products_country_id_idx" ON "products"("country_id");

-- CreateIndex
CREATE INDEX "products_form_id_idx" ON "products"("form_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Unique names: case and extra spaces do not matter ("ООО  Эвалар" = "ооо эвалар")
CREATE UNIQUE INDEX "brands_name_ru_norm_key" ON "brands" (lower(regexp_replace(btrim("name_ru"), '\s+', ' ', 'g')));
CREATE UNIQUE INDEX "manufacturers_name_ru_norm_key" ON "manufacturers" (lower(regexp_replace(btrim("name_ru"), '\s+', ' ', 'g')));
CREATE UNIQUE INDEX "countries_name_ru_norm_key" ON "countries" (lower(regexp_replace(btrim("name_ru"), '\s+', ' ', 'g')));
CREATE UNIQUE INDEX "forms_name_ru_norm_key" ON "forms" (lower(regexp_replace(btrim("name_ru"), '\s+', ' ', 'g')));

-- Dictionary values are never deleted, only archived (status = archived)
CREATE OR REPLACE FUNCTION forbid_dictionary_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dictionary values cannot be deleted; set status = archived';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER brands_no_delete BEFORE DELETE ON "brands" FOR EACH ROW EXECUTE FUNCTION forbid_dictionary_delete();
CREATE TRIGGER manufacturers_no_delete BEFORE DELETE ON "manufacturers" FOR EACH ROW EXECUTE FUNCTION forbid_dictionary_delete();
CREATE TRIGGER countries_no_delete BEFORE DELETE ON "countries" FOR EACH ROW EXECUTE FUNCTION forbid_dictionary_delete();
CREATE TRIGGER forms_no_delete BEFORE DELETE ON "forms" FOR EACH ROW EXECUTE FUNCTION forbid_dictionary_delete();

-- Yandex values: percents 0..100, sums not negative
ALTER TABLE "products" ADD CONSTRAINT "products_yandex_values_chk" CHECK (
  (yandex_price_uzs IS NULL OR yandex_price_uzs >= 0)
  AND (yandex_logistics_uzs IS NULL OR yandex_logistics_uzs >= 0)
  AND (yandex_commission_percent IS NULL OR yandex_commission_percent BETWEEN 0 AND 100)
  AND (yandex_payment_fee_percent IS NULL OR yandex_payment_fee_percent BETWEEN 0 AND 100)
);
