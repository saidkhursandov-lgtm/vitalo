-- 3.6: «Адрес на Яндекс Карте». Apartment, entrance, floor and landmark of a saved address are separate fields now
-- (the street and house come from the map or are typed by hand). Coordinates already exist (addresses.latitude/longitude,
-- orders.latitude/longitude). Only new nullable columns: nothing is dropped, renamed or deleted.
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "apartment" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "entrance" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "floor" TEXT;
ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "landmark" TEXT;
