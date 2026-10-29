-- Release 1: «Оплата при получении» (cash or a transfer to the courier), only for the city of Tashkent.
-- Only adds one payment method row if it is missing. No existing rows (orders, payments, settings, other
-- payment methods) are changed or deleted. timeout_minutes is not used for this method: such orders have no
-- payment deadline and wait for the manager's confirmation.
INSERT INTO "payment_methods" ("id", "code", "name_ru", "name_uz", "status", "timeout_minutes") VALUES
  (gen_random_uuid(), 'cod', 'Оплата при получении', 'Qabul qilganda to‘lash', 'enabled', 0)
ON CONFLICT ("code") DO NOTHING;
