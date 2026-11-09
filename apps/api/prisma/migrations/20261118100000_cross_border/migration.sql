-- Генплан, этап 6, ветка iherb-3-cross-border (D-60): «Под заказ из США» and its tracking for the customer.
-- Only additions: columns with defaults / nullable and two new tables. Nothing is ever deleted.

-- A line ordered from the USA (nothing in stock in Tashkent): no stock reservation until its jars arrive.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'local'; -- local | cross_border
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "cross_border_batch_id" UUID;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "arrived_at" TIMESTAMP(3); -- the line got its jars in Tashkent
CREATE INDEX IF NOT EXISTS "order_items_cross_border_idx" ON "order_items" ("source", "arrived_at");
CREATE INDEX IF NOT EXISTS "order_items_batch_idx" ON "order_items" ("cross_border_batch_id");

-- The promised delivery window of an order with lines from the USA (moved by staff with a reason).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "expected_from" DATE;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "expected_to" DATE;
-- the staff reminder «дата прошла, этап не сменился» was sent for this expected_to (once per date)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cross_border_overdue_for" DATE;

-- «Посылка из США»: one order on iHerb for several customers' lines
CREATE TABLE IF NOT EXISTS "cross_border_batches" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "number"        SERIAL        NOT NULL,
  "stage"         TEXT          NOT NULL DEFAULT 'ordered', -- ordered | shipped | arrived_uz | received
  "purchase_id"   UUID,
  "note"          TEXT,
  "ordered_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "shipped_at"    TIMESTAMP(3),
  "arrived_uz_at" TIMESTAMP(3),
  "received_at"   TIMESTAMP(3),
  "created_by"    UUID,
  "created_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cross_border_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "cross_border_batches_number_key" ON "cross_border_batches" ("number");
CREATE INDEX IF NOT EXISTS "cross_border_batches_stage_idx" ON "cross_border_batches" ("stage", "created_at");

-- What the customer's timeline is built from: a new stage of the order or a moved date (with the reason)
CREATE TABLE IF NOT EXISTS "cross_border_events" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "order_id"      UUID          NOT NULL,
  "batch_id"      UUID,
  "type"          TEXT          NOT NULL, -- stage | delay
  "stage"         TEXT,                   -- ordered | shipped | arrived_uz | in_stock
  "expected_from" DATE,
  "expected_to"   DATE,
  "reason"        TEXT,
  "created_by"    UUID,
  "created_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cross_border_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "cross_border_events_order_idx" ON "cross_border_events" ("order_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cross_border_batch_id_fkey" FOREIGN KEY ("cross_border_batch_id") REFERENCES "cross_border_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cross_border_batches" ADD CONSTRAINT "cross_border_batches_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cross_border_batches" ADD CONSTRAINT "cross_border_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cross_border_events" ADD CONSTRAINT "cross_border_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cross_border_events" ADD CONSTRAINT "cross_border_events_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "cross_border_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "cross_border_events" ADD CONSTRAINT "cross_border_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
