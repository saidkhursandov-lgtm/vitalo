-- Аудит админки 4.5: the text of a VITALO AI answer that was not shown to the customer (a check failed), for the
-- log of refusals in «Настройки → VITALO AI». Additive only.
ALTER TABLE ai_requests ADD COLUMN IF NOT EXISTS rejected_text TEXT;
