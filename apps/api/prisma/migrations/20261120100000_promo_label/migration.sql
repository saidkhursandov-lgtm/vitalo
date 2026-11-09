-- Этап 6а, подэтап В (D-62): manual promo label of a product, set in the admin product card.
-- Only an addition: one nullable column. Nothing is changed or deleted.
-- Values: eleven_eleven | black_friday | hit | new; NULL = no label.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "promo_label" TEXT;
