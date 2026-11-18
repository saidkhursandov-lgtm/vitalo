-- Release 6 «Сайт» (D-30): addresses by slug for products and brands, and the customer login outside Telegram.
-- Only additive: new column, functions, triggers, table. Existing slugs are never changed.

-- 1. A slug from a Russian / Uzbek / Latin name: lower case, Cyrillic transliterated, the rest -> «-».
CREATE OR REPLACE FUNCTION vitalo_slugify(src text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text := lower(coalesce(src, ''));
BEGIN
  s := replace(s, 'щ', 'shch'); s := replace(s, 'ш', 'sh'); s := replace(s, 'ч', 'ch'); s := replace(s, 'ж', 'zh');
  s := replace(s, 'ю', 'yu');   s := replace(s, 'я', 'ya'); s := replace(s, 'ё', 'yo'); s := replace(s, 'х', 'kh');
  s := replace(s, 'ц', 'ts');   s := replace(s, 'ў', 'o');  s := replace(s, 'қ', 'q');  s := replace(s, 'ғ', 'g');
  s := replace(s, 'ҳ', 'h');
  s := translate(s, 'абвгдезийклмнопрстуфыэъь', 'abvgdeziyklmnoprstufye');
  s := translate(s, 'àáâäãåèéêëìíîïòóôöõùúûüñç', 'aaaaaaeeeeiiiiooooouuuunc');
  s := regexp_replace(s, '[‘’ʻʼ''`]', '', 'g');
  s := regexp_replace(s, '[^a-z0-9]+', '-', 'g');
  s := trim(both '-' from s);
  s := trim(both '-' from left(s, 80));
  RETURN CASE WHEN s = '' THEN 'item' ELSE s END;
END $$;

-- 2. products.slug
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "slug" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_key" ON "products"("slug");

-- A free slug: the base, else base-2, base-3 …
CREATE OR REPLACE FUNCTION vitalo_free_product_slug(base text, self uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE candidate text := base; n int := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM products WHERE slug = candidate AND id <> self) LOOP
    n := n + 1; candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END $$;

CREATE OR REPLACE FUNCTION vitalo_products_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := vitalo_free_product_slug(vitalo_slugify(NEW.name_ru), NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS products_slug_fill ON "products";
CREATE TRIGGER products_slug_fill BEFORE INSERT OR UPDATE ON "products"
  FOR EACH ROW WHEN (NEW.slug IS NULL OR NEW.slug = '') EXECUTE FUNCTION vitalo_products_slug();

-- Existing products, oldest first (one statement per row, so each sees the slugs given before it).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, name_ru FROM products WHERE slug IS NULL ORDER BY created_at, id LOOP
    UPDATE products SET slug = vitalo_free_product_slug(vitalo_slugify(r.name_ru), r.id) WHERE id = r.id;
  END LOOP;
END $$;

-- 3. brands.slug (the column exists since 2.2; fill the empty ones the same way)
CREATE OR REPLACE FUNCTION vitalo_free_brand_slug(base text, self uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE candidate text := base; n int := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM brands WHERE slug = candidate AND id <> self) LOOP
    n := n + 1; candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END $$;

CREATE OR REPLACE FUNCTION vitalo_brands_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := vitalo_free_brand_slug(vitalo_slugify(NEW.name_ru), NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS brands_slug_fill ON "brands";
CREATE TRIGGER brands_slug_fill BEFORE INSERT OR UPDATE ON "brands"
  FOR EACH ROW WHEN (NEW.slug IS NULL OR NEW.slug = '') EXECUTE FUNCTION vitalo_brands_slug();

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, name_ru FROM brands WHERE slug IS NULL OR slug = '' ORDER BY created_at, id LOOP
    UPDATE brands SET slug = vitalo_free_brand_slug(vitalo_slugify(r.name_ru), r.id) WHERE id = r.id;
  END LOOP;
END $$;

-- 4. Customer login on the site: «Войти через Telegram» (confirmed in the bot) and «По номеру телефона»
--    (a 6-digit code sent by the bot to the customer who has this phone). The session is the usual user_sessions row.
CREATE TABLE IF NOT EXISTS "customer_login_requests" (
  "id"               UUID NOT NULL,
  "kind"             TEXT NOT NULL,              -- 'telegram' | 'phone'
  "poll_hash"        TEXT NOT NULL,              -- sha256 of the browser's secret
  "code_hash"        TEXT,                       -- phone: sha256 of the code
  "phone"            TEXT,
  "user_id"          UUID,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "device_info"      TEXT,
  "ip"               TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "approved_at"      TIMESTAMP(3),
  "used_at"          TIMESTAMP(3),
  CONSTRAINT "customer_login_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "customer_login_requests_phone_created_at_idx" ON "customer_login_requests"("phone", "created_at");
DO $$ BEGIN
  ALTER TABLE "customer_login_requests" ADD CONSTRAINT "customer_login_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
