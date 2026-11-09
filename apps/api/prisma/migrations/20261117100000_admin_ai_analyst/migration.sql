-- Генплан, этап 5, ветка admin-ai-analyst (D-57, узел 5): the admin AI analyst, best-seller place and competitor orders.
-- Only additions: two nullable columns and three new tables. Nothing is ever deleted: facts are switched off (active = false).

ALTER TABLE "iherb_price_snapshots" ADD COLUMN IF NOT EXISTS "bestseller_rank" INTEGER;
ALTER TABLE "competitor_prices" ADD COLUMN IF NOT EXISTS "orders_count" INTEGER;

-- «Что я прислал»: the raw text and what the model read from it (checked by our code)
CREATE TABLE IF NOT EXISTS "admin_ai_feed" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "staff_user_id" UUID,
  "raw_text"      TEXT          NOT NULL,
  "status"        TEXT          NOT NULL DEFAULT 'parsed', -- parsed | saved | failed
  "rows"          JSONB         NOT NULL DEFAULT '[]',
  "saved"         JSONB,
  "error_code"    TEXT,
  "request_id"    UUID,
  "created_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "saved_at"      TIMESTAMP(3),
  CONSTRAINT "admin_ai_feed_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "admin_ai_feed_created_idx" ON "admin_ai_feed" ("created_at");

-- «Память о бизнесе»: one fact per row
CREATE TABLE IF NOT EXISTS "admin_business_memory" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "kind"          TEXT          NOT NULL, -- competitor_price | orders | bestseller_rank | decision | note
  "product_id"    UUID,
  "platform"      TEXT,
  "seller"        TEXT,
  "value_num"     DECIMAL(18,2),
  "value_text"    TEXT,
  "observed_on"   DATE          NOT NULL,
  "source"        TEXT          NOT NULL DEFAULT 'feed', -- feed | manual
  "feed_id"       UUID,
  "staff_user_id" UUID,
  "active"        BOOLEAN       NOT NULL DEFAULT true,
  "created_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_business_memory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "admin_business_memory_active_idx" ON "admin_business_memory" ("active", "observed_on");
CREATE INDEX IF NOT EXISTS "admin_business_memory_product_idx" ON "admin_business_memory" ("product_id");

-- «Журнал запросов»: every call to the model, tokens and cost (the monthly budget)
CREATE TABLE IF NOT EXISTS "admin_ai_requests" (
  "id"                 UUID          NOT NULL DEFAULT gen_random_uuid(),
  "staff_user_id"      UUID,
  "scenario"           TEXT          NOT NULL, -- feed | chat
  "model"              TEXT          NOT NULL,
  "question"           TEXT,
  "answer"             TEXT,
  "input_tokens"       INTEGER       NOT NULL DEFAULT 0,
  "output_tokens"      INTEGER       NOT NULL DEFAULT 0,
  "cache_read_tokens"  INTEGER       NOT NULL DEFAULT 0,
  "cache_write_tokens" INTEGER       NOT NULL DEFAULT 0,
  "cost_usd"           DECIMAL(12,6) NOT NULL DEFAULT 0,
  "outcome"            TEXT          NOT NULL, -- ok | refusal | max_tokens | not_json | error
  "error_code"         TEXT,
  "latency_ms"         INTEGER       NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_ai_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "admin_ai_requests_created_idx" ON "admin_ai_requests" ("created_at");

DO $$ BEGIN
  ALTER TABLE "admin_ai_feed" ADD CONSTRAINT "admin_ai_feed_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "admin_business_memory" ADD CONSTRAINT "admin_business_memory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "admin_business_memory" ADD CONSTRAINT "admin_business_memory_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "admin_ai_feed"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "admin_business_memory" ADD CONSTRAINT "admin_business_memory_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "admin_ai_requests" ADD CONSTRAINT "admin_ai_requests_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
