-- Launch, block D. Only ADDS columns and settings; the one data change below is the documents tile switch the owner asked for.

-- D2: optimized photo versions (main up to 1200 px and a 400 px thumbnail, WebP + JPEG fallback) and the size,
-- so pages do not jump while images load. Old photos keep NULL here until scripts/optimize-photos.ts runs.
ALTER TABLE "product_media"
  ADD COLUMN IF NOT EXISTS "url_jpeg" TEXT,
  ADD COLUMN IF NOT EXISTS "thumb_url" TEXT,
  ADD COLUMN IF NOT EXISTS "thumb_url_jpeg" TEXT,
  ADD COLUMN IF NOT EXISTS "width" INTEGER,
  ADD COLUMN IF NOT EXISTS "height" INTEGER;

-- D3: one payment reminder per order
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_reminder_sent_at" TIMESTAMP(3);

-- D3: how many hours before the automatic cancellation the bot reminds the customer
INSERT INTO "settings" ("key", "value", "updated_at") VALUES ('payment_reminder_hours', '3', now())
ON CONFLICT ("key") DO NOTHING;

-- D4: the "Документы на каждый товар" tile is off until products have documents (switch on in Настройки → Главная)
UPDATE "settings" s SET "value" = jsonb_set(s."value", ARRAY['trust', t.idx::text, 'enabled'], 'false'::jsonb), "updated_at" = now()
FROM (
  SELECT e.ord - 1 AS idx FROM "settings" x, jsonb_array_elements(x."value" -> 'trust') WITH ORDINALITY AS e(tile, ord)
  WHERE x."key" = 'home_content' AND e.tile ->> 'key' = 'documents' AND e.tile ->> 'enabled' = 'true'
) t
WHERE s."key" = 'home_content';
