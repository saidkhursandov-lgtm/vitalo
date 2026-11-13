-- 3.10-Б «Проверенные отзывы». Additive only: new type, tables, columns and indexes.

DO $$ BEGIN
  CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'published', 'rejected', 'hidden');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "review_requests" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "review_asked_at" TIMESTAMP(3);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "reviews_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "rating_sum" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "reviews" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" SMALLINT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text" TEXT,
    "show_name" BOOLEAN NOT NULL DEFAULT true,
    "author_name" TEXT NOT NULL,
    "lang" "Lang" NOT NULL DEFAULT 'ru',
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "reject_reason" TEXT,
    "reject_note" TEXT,
    "moderated_by" UUID,
    "moderated_at" TIMESTAMP(3),
    "reply_text" TEXT,
    "replied_by" UUID,
    "replied_at" TIMESTAMP(3),
    "bonus_uzs" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "review_media" (
    "id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "sort" SMALLINT NOT NULL DEFAULT 0,
    "private_key" TEXT NOT NULL,
    "url" TEXT,
    "url_jpeg" TEXT,
    "thumb_url" TEXT,
    "thumb_url_jpeg" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_order_id_product_id_key" ON "reviews"("order_id", "product_id");
CREATE INDEX IF NOT EXISTS "reviews_product_id_status_published_at_idx" ON "reviews"("product_id", "status", "published_at");
CREATE INDEX IF NOT EXISTS "reviews_status_created_at_idx" ON "reviews"("status", "created_at");
CREATE INDEX IF NOT EXISTS "reviews_user_id_created_at_idx" ON "reviews"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "review_media_review_id_idx" ON "review_media"("review_id");

DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_fkey" FOREIGN KEY ("moderated_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_replied_by_fkey" FOREIGN KEY ("replied_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "review_media" ADD CONSTRAINT "review_media_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
