-- 4.3 «Сеты от врача» (only new tables)
CREATE TABLE IF NOT EXISTS "bundles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title_ru" TEXT NOT NULL,
    "title_uz" TEXT,
    "goal" TEXT,
    "doctor_text_ru" TEXT,
    "doctor_text_uz" TEXT,
    "discount_pct" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bundles_slug_key" ON "bundles"("slug");

CREATE TABLE IF NOT EXISTS "bundle_items" (
    "id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "bundle_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bundle_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "bundle_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "bundle_items_bundle_id_product_id_key" ON "bundle_items"("bundle_id", "product_id");
CREATE INDEX IF NOT EXISTS "bundle_items_product_id_idx" ON "bundle_items"("product_id");
