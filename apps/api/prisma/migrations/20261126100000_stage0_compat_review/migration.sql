-- Шаг 0а-3 (D-66, архитектура 3.3): сохранённый ответ специалиста, у которого другая метка, чем у VITALO AI по текущим
-- правилам, помечается «пересмотреть — правила изменились». Только добавляющая: две новые пустые колонки,
-- существующие записи не меняются.
ALTER TABLE "compat_answers" ADD COLUMN IF NOT EXISTS "review_needed_at" TIMESTAMP(3);
ALTER TABLE "compat_answers" ADD COLUMN IF NOT EXISTS "review_ai_verdict" TEXT;
