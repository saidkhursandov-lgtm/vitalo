-- Генплан, этап 3 (D-56): the admin panel in an ordinary browser at admin.vitalo.uz.
-- Telegram Login Widget + confirmation in the bot for a new device, 30-day cookie sessions, «Мои устройства»,
-- one-time backup codes of the owner. Additive only: new columns with defaults and new tables.

ALTER TABLE "staff_sessions" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE "staff_sessions" ADD COLUMN IF NOT EXISTS "device_id" UUID;
ALTER TABLE "staff_sessions" ADD COLUMN IF NOT EXISTS "device_name" TEXT;
ALTER TABLE "staff_sessions" ADD COLUMN IF NOT EXISTS "ip" TEXT;
ALTER TABLE "staff_sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP(3);

-- A browser the employee confirmed in the bot: its random token lives in an HttpOnly cookie, only the hash here.
CREATE TABLE IF NOT EXISTS "staff_devices" (
  "id" UUID NOT NULL,
  "staff_user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "staff_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_devices_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_devices_token_hash_key" ON "staff_devices"("token_hash");
CREATE INDEX IF NOT EXISTS "staff_devices_staff_user_id_idx" ON "staff_devices"("staff_user_id");

-- «Вход с нового устройства — Подтвердить / Это не я»: waits for the button in the bot (a few minutes).
CREATE TABLE IF NOT EXISTS "staff_login_requests" (
  "id" UUID NOT NULL,
  "staff_user_id" UUID NOT NULL,
  "poll_hash" TEXT NOT NULL,
  "device_name" TEXT NOT NULL,
  "ip" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "decided_at" TIMESTAMP(3),
  "session_issued_at" TIMESTAMP(3),
  CONSTRAINT "staff_login_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_login_requests_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "staff_login_requests_staff_user_id_idx" ON "staff_login_requests"("staff_user_id");

-- The owner's emergency codes (when the bot or Telegram is down): one-time, only hashes are kept.
CREATE TABLE IF NOT EXISTS "staff_backup_codes" (
  "id" UUID NOT NULL,
  "staff_user_id" UUID NOT NULL,
  "code_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "staff_backup_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_backup_codes_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_backup_codes_code_hash_key" ON "staff_backup_codes"("code_hash");
CREATE INDEX IF NOT EXISTS "staff_backup_codes_staff_user_id_idx" ON "staff_backup_codes"("staff_user_id");
