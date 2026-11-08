-- Генплан, этап 5, ветка iherb-2-prices (D-57): iHerb price snapshots from an uploaded wishlist, the auto price log
-- and the 09/15/21 reminders. Only additions: new tables and indexes, nothing existing is changed or removed.

-- One upload of the wishlist (the owner pastes the page / saves it as a file): who, when, how many lines.
CREATE TABLE IF NOT EXISTS "iherb_uploads" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "staff_user_id"  UUID,
  "source"         TEXT         NOT NULL DEFAULT 'wishlist',
  "items_total"    INTEGER      NOT NULL DEFAULT 0,
  "items_matched"  INTEGER      NOT NULL DEFAULT 0,
  "prices_changed" INTEGER      NOT NULL DEFAULT 0,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iherb_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "iherb_uploads_created_at_idx" ON "iherb_uploads" ("created_at");

-- PriceHistory: one iHerb price of one product at one moment. Products not linked yet are kept too (product_id NULL):
-- when the link is added later, the history is already there (matched by iherb_product_id).
CREATE TABLE IF NOT EXISTS "iherb_price_snapshots" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "upload_id"        UUID          NOT NULL,
  "product_id"       UUID,
  "iherb_product_id" TEXT          NOT NULL,
  "title"            TEXT,
  "price_uzs"        BIGINT        NOT NULL,
  "list_price_uzs"   BIGINT,
  "in_stock"         BOOLEAN       NOT NULL DEFAULT true,
  "bestseller"       BOOLEAN       NOT NULL DEFAULT false,
  "weight_kg"        DECIMAL(8,3),
  "source"           TEXT          NOT NULL DEFAULT 'wishlist',
  "taken_at"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iherb_price_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "iherb_price_snapshots_iherb_taken_idx" ON "iherb_price_snapshots" ("iherb_product_id", "taken_at");
CREATE INDEX IF NOT EXISTS "iherb_price_snapshots_product_taken_idx" ON "iherb_price_snapshots" ("product_id", "taken_at");
CREATE INDEX IF NOT EXISTS "iherb_price_snapshots_upload_idx" ON "iherb_price_snapshots" ("upload_id");

-- Auto price log: was / became / why; applied or skipped (and why skipped). Nothing waits for approval (D-57).
CREATE TABLE IF NOT EXISTS "price_changes" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "product_id"      UUID         NOT NULL,
  "upload_id"       UUID,
  "staff_user_id"   UUID,
  "reason"          TEXT         NOT NULL DEFAULT 'iherb_auto',
  "status"          TEXT         NOT NULL,
  "skip_reason"     TEXT,
  "old_price_uzs"   BIGINT       NOT NULL,
  "new_price_uzs"   BIGINT       NOT NULL,
  "iherb_price_uzs" BIGINT,
  "markup_percent"  INTEGER,
  "floor_applied"   BOOLEAN      NOT NULL DEFAULT false,
  "big_jump"        BOOLEAN      NOT NULL DEFAULT false,
  "yandex_check"    BOOLEAN      NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "price_changes_product_created_idx" ON "price_changes" ("product_id", "created_at");
CREATE INDEX IF NOT EXISTS "price_changes_created_idx" ON "price_changes" ("created_at");

-- A reminder slot (09:00 / 15:00 / 21:00 Tashkent) is sent once, even with a restart or two API processes.
CREATE TABLE IF NOT EXISTS "iherb_reminders" (
  "slot"       TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iherb_reminders_pkey" PRIMARY KEY ("slot")
);

DO $$ BEGIN
  ALTER TABLE "iherb_uploads" ADD CONSTRAINT "iherb_uploads_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "iherb_price_snapshots" ADD CONSTRAINT "iherb_price_snapshots_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "iherb_uploads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "iherb_price_snapshots" ADD CONSTRAINT "iherb_price_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "iherb_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
