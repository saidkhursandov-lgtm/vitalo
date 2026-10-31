-- Stage 2.4: waiting list «Сообщить о поступлении». Only ADDS things (rules for the production database).
CREATE TABLE IF NOT EXISTS "product_waitlist" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),
    CONSTRAINT "product_waitlist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_waitlist_product_id_user_id_key" ON "product_waitlist"("product_id", "user_id");
CREATE INDEX IF NOT EXISTS "product_waitlist_notified_at_idx" ON "product_waitlist"("notified_at");

DO $$ BEGIN
  ALTER TABLE "product_waitlist" ADD CONSTRAINT "product_waitlist_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_waitlist" ADD CONSTRAINT "product_waitlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
