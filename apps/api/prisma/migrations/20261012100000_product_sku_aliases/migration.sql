-- Alternative SKUs of a product (old codes for the Yandex sync and the product search). Only adds a table, an
-- index, constraints and triggers. Existing rows are not changed.

-- CreateTable
CREATE TABLE "product_sku_aliases" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "alias_norm" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sku_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_sku_aliases_alias_norm_key" ON "product_sku_aliases"("alias_norm");

-- CreateIndex
CREATE INDEX "product_sku_aliases_product_id_idx" ON "product_sku_aliases"("product_id");

-- AddForeignKey
ALTER TABLE "product_sku_aliases" ADD CONSTRAINT "product_sku_aliases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── rules Prisma cannot express ─────────────

-- alias_norm is the alias trimmed and upper-cased: uniqueness ignores case
ALTER TABLE "product_sku_aliases" ADD CONSTRAINT "product_sku_aliases_values_chk" CHECK (
  source IN ('yandex', 'internal')
  AND char_length(btrim(alias)) BETWEEN 2 AND 64
  AND alias_norm = upper(btrim(alias))
);

-- An alias is never the SKU of a product (of its own product it would be pointless, of another — ambiguous)
CREATE OR REPLACE FUNCTION check_sku_alias_vs_products() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE upper(btrim(sku)) = NEW.alias_norm) THEN
    RAISE EXCEPTION 'alias % equals the SKU of a product', NEW.alias;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER product_sku_aliases_vs_sku BEFORE INSERT OR UPDATE ON "product_sku_aliases" FOR EACH ROW EXECUTE FUNCTION check_sku_alias_vs_products();

-- A product SKU never takes the alias of ANOTHER product (its own alias may become its SKU)
CREATE OR REPLACE FUNCTION check_product_sku_vs_aliases() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_sku_aliases WHERE alias_norm = upper(btrim(NEW.sku)) AND product_id <> NEW.id) THEN
    RAISE EXCEPTION 'SKU % is an alternative SKU of another product', NEW.sku;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER products_sku_vs_aliases BEFORE INSERT OR UPDATE OF sku ON "products" FOR EACH ROW EXECUTE FUNCTION check_product_sku_vs_aliases();
