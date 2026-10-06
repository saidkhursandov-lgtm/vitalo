-- Stage 0.2: the background job reminds admins and managers once when a payment reported by the customer
-- («Я оплатил(а)») stays unconfirmed for N hours (setting payment_check_reminder_hours, default 3).
-- Only adds a nullable column; existing rows stay NULL ("not reminded yet").
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_check_reminder_sent_at" TIMESTAMP(3);
