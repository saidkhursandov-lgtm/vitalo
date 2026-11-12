-- 3.10-А (D-71): VITALO Bonus. Additive only.
-- «Сгорание» (90 days after the last purchase) and the review bonus of 3.10-Б.
ALTER TYPE "BonusOp" ADD VALUE IF NOT EXISTS 'expire';
ALTER TYPE "BonusOp" ADD VALUE IF NOT EXISTS 'review';

-- the switch «Списать бонусы» in the cart
ALTER TABLE "carts" ADD COLUMN IF NOT EXISTS "use_bonus" BOOLEAN NOT NULL DEFAULT false;

-- the lifetime counts from the last accrual; the reminder is sent once per such date
ALTER TABLE "bonus_accounts" ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3);
ALTER TABLE "bonus_accounts" ADD COLUMN IF NOT EXISTS "expiry_notified_for" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "bonus_accounts_last_activity_at_idx" ON "bonus_accounts"("last_activity_at");
CREATE INDEX IF NOT EXISTS "bonus_ledger_order_id_idx" ON "bonus_ledger"("order_id");
CREATE INDEX IF NOT EXISTS "bonus_ledger_created_at_idx" ON "bonus_ledger"("created_at");
