-- Stage 2.1. Only ADDS things; nothing is changed, renamed or deleted (rules for the production database).
-- 1) Optional short product name (RU / UZ) for the cart, checkout, orders and bot messages.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name_ru" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "short_name_uz" TEXT;

-- 2) Online payments skeleton (Payme / Click / Uzum are not connected yet): the payment page link and its expiry.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "checkout_url" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);

-- 3) Payment method rows for the online providers, switched off. Existing rows (if any) are left as they are.
INSERT INTO "payment_methods" ("id", "code", "name_ru", "name_uz", "status", "timeout_minutes") VALUES
  (gen_random_uuid(), 'payme', 'Payme', 'Payme', 'disabled', 30),
  (gen_random_uuid(), 'click', 'Click', 'Click', 'disabled', 30),
  (gen_random_uuid(), 'uzum', 'Uzum', 'Uzum', 'disabled', 30)
ON CONFLICT ("code") DO NOTHING;
