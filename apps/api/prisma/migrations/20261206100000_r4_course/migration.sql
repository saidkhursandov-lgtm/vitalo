-- 4.2: «Курс заканчивается» — the customer can switch the reminder off («Не напоминать», profile)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "course_reminders" BOOLEAN NOT NULL DEFAULT true;
