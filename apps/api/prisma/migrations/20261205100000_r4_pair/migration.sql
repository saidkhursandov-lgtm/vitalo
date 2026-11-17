-- Release 4.1 «Идеальная пара»: the pair is picked from the approved synergy rules; an admin may choose it by hand
-- (pair_product_id) or switch the block off (pair_off). Additive only.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pair_product_id" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pair_off" BOOLEAN NOT NULL DEFAULT false;
