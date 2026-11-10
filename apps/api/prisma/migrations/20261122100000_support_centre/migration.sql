-- 6б-Б (D-63): the support centre — a number for every request, the order it is about, who closed it and the
-- customer's rating. Additive only: new columns, an index and a foreign key; existing requests get numbers 1, 2, 3…
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "number" SERIAL;
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "order_id" UUID;
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "started_by" TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMP(3);
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "closed_by" UUID;
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "rating" SMALLINT;
ALTER TABLE "support_threads" ADD COLUMN IF NOT EXISTS "rated_at" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "support_threads_number_key" ON "support_threads"("number");
CREATE INDEX IF NOT EXISTS "support_threads_order_id_idx" ON "support_threads"("order_id");

DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
