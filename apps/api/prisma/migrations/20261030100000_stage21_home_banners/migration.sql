-- Stage 2.1: home banners managed in the admin panel. Only ADDS things (rules for the production database).
CREATE TABLE IF NOT EXISTS "home_banners" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "image_ru_url" TEXT,
    "image_ru_jpeg" TEXT,
    "image_uz_url" TEXT,
    "image_uz_jpeg" TEXT,
    "link_type" TEXT,
    "link_value" TEXT,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "home_banners_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "home_banners_sort_order_idx" ON "home_banners"("sort_order");

-- The two banners the shop already shows keep working as items of the same list (fixed ids, added once).
INSERT INTO "home_banners" ("id", "kind", "enabled", "sort_order", "updated_at") VALUES
  ('00000000-0000-4000-8000-00000000b001', 'doctor', true, 1, CURRENT_TIMESTAMP),
  ('00000000-0000-4000-8000-00000000b002', 'delivery', true, 2, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
