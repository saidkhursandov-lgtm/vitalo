-- Надпись «Форма вещества» из справочника веществ. Additive only: two columns of product_substances.
ALTER TABLE "product_substances" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_substances" ADD COLUMN IF NOT EXISTS "in_label" BOOLEAN NOT NULL DEFAULT false;
