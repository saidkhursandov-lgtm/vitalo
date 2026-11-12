-- D-70: VITALO AI conversations about the cart. Additive only.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_chat_consent_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ai_chats" (
  "id" UUID NOT NULL,
  "number" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "lang" TEXT NOT NULL,
  "cart" JSONB NOT NULL DEFAULT '[]',
  "empty_cart" BOOLEAN NOT NULL DEFAULT false,
  "topic" TEXT,
  "outcome" TEXT,
  "questions" INTEGER NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "model" TEXT,
  "review" TEXT,
  "review_note" TEXT,
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMP(3),
  "deleted_at" TIMESTAMP(3),
  "purged_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_chats_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_chats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_chats_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_chats_number_key" ON "ai_chats"("number");
CREATE INDEX IF NOT EXISTS "ai_chats_created_at_idx" ON "ai_chats"("created_at");
CREATE INDEX IF NOT EXISTS "ai_chats_user_id_created_at_idx" ON "ai_chats"("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "ai_chat_messages" (
  "id" UUID NOT NULL,
  "chat_id" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT,
  "payload" JSONB,
  "model" TEXT,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "latency_ms" INTEGER,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_chat_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "ai_chats"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ai_chat_messages_chat_id_created_at_idx" ON "ai_chat_messages"("chat_id", "created_at");
