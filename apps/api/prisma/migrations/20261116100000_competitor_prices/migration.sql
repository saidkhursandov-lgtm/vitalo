-- Генплан, этап 5, ветка iherb-4-competitors (D-57, узел 4; заменяет П4): competitor prices with the strict «1-в-1» match.
-- Only additions: one new table and its indexes. A row is never deleted: «Убрать» sets hidden_at.

CREATE TABLE IF NOT EXISTS "competitor_prices" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "product_id"       UUID          NOT NULL,
  "platform"         TEXT          NOT NULL,          -- uzum | yandex_market | pharmacy | social | other
  "seller"           TEXT,                            -- shop / pharmacy name
  "title"            TEXT,                            -- the product name at the competitor
  "url"              TEXT,
  "price_uzs"        BIGINT        NOT NULL,
  "observed_on"      DATE          NOT NULL,
  -- what the competitor sells: the four «1-в-1» values
  "brand"            TEXT,
  "match_form"       TEXT,
  "dose_amount"      DECIMAL(12,3),
  "dose_unit"        TEXT,
  "dose_per"         TEXT,
  "pack_count"       INTEGER,
  -- result of the match at the moment of saving: match | mismatch | incomplete; reasons in plain words
  "match_status"     TEXT          NOT NULL,
  "mismatch_reasons" JSONB         NOT NULL DEFAULT '[]',
  "source"           TEXT          NOT NULL DEFAULT 'manual', -- manual | ai (the admin AI analyst, after «Сохранить»)
  "staff_user_id"    UUID,
  "hidden_at"        TIMESTAMP(3),
  "created_at"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "competitor_prices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "competitor_prices_product_observed_idx" ON "competitor_prices" ("product_id", "observed_on");

DO $$ BEGIN
  ALTER TABLE "competitor_prices" ADD CONSTRAINT "competitor_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "competitor_prices" ADD CONSTRAINT "competitor_prices_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
