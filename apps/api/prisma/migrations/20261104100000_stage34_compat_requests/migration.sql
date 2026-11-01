-- Stage 3.4: «Проверить совместимость у специалиста» (D-40). Only ADDS things (rules for the production database):
-- a defaulted column, two new tables, indexes, foreign keys. Safe to run twice.
ALTER TABLE "staff_users" ADD COLUMN IF NOT EXISTS "is_specialist" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "compat_answers" (
    "id" UUID NOT NULL,
    "set_key" TEXT NOT NULL,
    "product_ids" UUID[],
    "items" JSONB NOT NULL,
    "lang" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source_request_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compat_answers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "compat_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_ids" UUID[],
    "set_key" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "lang" TEXT NOT NULL,
    "comment" TEXT,
    "comment_purged_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'specialist',
    "verdict" TEXT,
    "answer_text" TEXT,
    "answered_by" UUID,
    "answered_at" TIMESTAMP(3),
    "saved_answer_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compat_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "compat_requests_user_id_created_at_idx" ON "compat_requests"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "compat_requests_status_created_at_idx" ON "compat_requests"("status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "compat_answers_set_key_lang_key" ON "compat_answers"("set_key", "lang");

DO $$ BEGIN
  ALTER TABLE "compat_requests" ADD CONSTRAINT "compat_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "compat_requests" ADD CONSTRAINT "compat_requests_answered_by_fkey" FOREIGN KEY ("answered_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "compat_requests" ADD CONSTRAINT "compat_requests_saved_answer_id_fkey" FOREIGN KEY ("saved_answer_id") REFERENCES "compat_answers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "compat_answers" ADD CONSTRAINT "compat_answers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
