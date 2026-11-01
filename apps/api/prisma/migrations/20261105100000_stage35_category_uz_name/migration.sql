-- 3.5: shorter Uzbek name of the «Креатин и аминокислоты» category, so it fits a 320 px tile.
-- Only the exact old default is changed: a name already edited in the admin panel stays as it is.
-- Nothing is dropped or deleted.
UPDATE "categories"
SET "name_uz" = 'Kreatin va aminolar'
WHERE "slug" = 'creatine-amino' AND "name_uz" = 'Kreatin va aminokislotalar';
