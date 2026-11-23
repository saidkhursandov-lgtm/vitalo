-- Click (SHOP API: Prepare / Complete): one-time payments for an order. Only ADDS things (rules for the production
-- database): a new table, indexes, foreign keys. Nothing is changed, renamed or deleted.
-- id = merchant_prepare_id = merchant_confirm_id (Click expects an integer). state: 0 prepared, 1 completed, -1 cancelled.
CREATE TABLE IF NOT EXISTS "click_transactions" (
  "id"               SERIAL       NOT NULL,
  "click_trans_id"   BIGINT       NOT NULL,
  "click_paydoc_id"  BIGINT       NOT NULL,
  "order_id"         UUID         NOT NULL,
  "payment_id"       UUID,
  "amount_tiyin"     BIGINT       NOT NULL,
  "state"            INTEGER      NOT NULL,
  "sign_time"        TEXT         NOT NULL,
  "click_error"      INTEGER,
  "click_error_note" TEXT,
  "completed_at"     TIMESTAMP(3),
  "cancelled_at"     TIMESTAMP(3),
  "fiscal_status"    TEXT,
  "fiscal_error"     TEXT,
  "fiscal_attempts"  INTEGER      NOT NULL DEFAULT 0,
  "fiscal_sent_at"   TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "click_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "click_transactions_click_trans_id_key" ON "click_transactions"("click_trans_id");
CREATE INDEX IF NOT EXISTS "click_transactions_order_id_state_idx" ON "click_transactions"("order_id", "state");
CREATE INDEX IF NOT EXISTS "click_transactions_fiscal_status_idx" ON "click_transactions"("fiscal_status");
DO $$ BEGIN
  ALTER TABLE "click_transactions" ADD CONSTRAINT "click_transactions_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "click_transactions" ADD CONSTRAINT "click_transactions_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
