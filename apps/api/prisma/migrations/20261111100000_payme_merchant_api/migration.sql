-- Payme (Merchant API): one-time payments for an order. Only ADDS things (rules for the production database):
-- nullable product columns, a new table, indexes. Nothing is changed, renamed or deleted.

-- 1) Fiscal receipt data of a product (Payme sends it to the tax office): ИКПУ (MXIK) and the package code.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ikpu_code" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "package_code" TEXT;

-- 2) Payme transactions: one row per Payme transaction id. state: 1 created, 2 performed, -1 cancelled before
--    the payment, -2 cancelled after it. Times are milliseconds since 1970 (as Payme sends and expects them).
CREATE TABLE IF NOT EXISTS "payme_transactions" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "payme_id"     TEXT         NOT NULL,
  "order_id"     UUID         NOT NULL,
  "payment_id"   UUID,
  "amount_tiyin" BIGINT       NOT NULL,
  "state"        INTEGER      NOT NULL,
  "payme_time"   BIGINT       NOT NULL,
  "create_time"  BIGINT       NOT NULL,
  "perform_time" BIGINT,
  "cancel_time"  BIGINT,
  "reason"       INTEGER,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payme_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payme_transactions_payme_id_key" ON "payme_transactions"("payme_id");
CREATE INDEX IF NOT EXISTS "payme_transactions_order_id_state_idx" ON "payme_transactions"("order_id", "state");
CREATE INDEX IF NOT EXISTS "payme_transactions_payme_time_idx" ON "payme_transactions"("payme_time");
DO $$ BEGIN
  ALTER TABLE "payme_transactions" ADD CONSTRAINT "payme_transactions_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "payme_transactions" ADD CONSTRAINT "payme_transactions_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
