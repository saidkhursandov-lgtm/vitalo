-- Stage 2.4 patch: the bell is a switch; a cancelled subscription is marked, never deleted. Only ADDS things.
ALTER TABLE "product_waitlist" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3);
