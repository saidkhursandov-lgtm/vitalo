-- Search normalization for typo-tolerant, transliteration-aware product search (pg_trgm).
-- vitalo_norm() maps Russian / Uzbek (Cyrillic + Latin) / English spellings to one phonetic Latin
-- form, e.g. 'Коллаген', 'collagen', 'kollagen', 'колаген' -> 'kolagen'; 'Цинк', 'zinc' -> 'zink'.
-- The same function is applied to the search query, so both sides always agree.
-- Declared IMMUTABLE so it can back an expression index (unaccent is called with an explicit dictionary).

CREATE OR REPLACE FUNCTION vitalo_norm(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  s text := lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t, '')));
BEGIN
  -- Uzbek Latin apostrophes: o'zbek / oʻzbek / o‘zbek -> ozbek
  s := regexp_replace(s, '[''`ʻʼ‘’]', '', 'g');

  -- Standalone Cyrillic "в"/"с" are vitamin letters (Витамин С, В12) -> Latin b/c, not v/s
  s := regexp_replace(s, '(^|[^a-zа-яёўқғҳ0-9])в(?=[0-9]*([^a-zа-яёўқғҳ0-9]|$))', '\1b', 'g');
  s := regexp_replace(s, '(^|[^a-zа-яёўқғҳ0-9])с(?=[0-9]*([^a-zа-яёўқғҳ0-9]|$))', '\1c', 'g');

  -- Cyrillic -> Latin
  s := replace(s, 'щ', 'sh');
  s := replace(s, 'ш', 'sh');
  s := replace(s, 'ж', 'zh');
  s := replace(s, 'ч', 'ch');
  s := replace(s, 'ц', 'z');
  s := replace(s, 'х', 'h');
  s := replace(s, 'ю', 'yu');
  s := replace(s, 'я', 'ya');
  s := translate(s, 'абвгдеёзийклмнопрстуфыэўқғҳъь', 'abvgdeeziiklmnoprstufieokgh');

  -- Latin phonetic folding (so English / typed transliterations meet the Cyrillic form)
  s := replace(s, 'sch', 'sh');
  s := replace(s, 'ph', 'f');
  s := replace(s, 'th', 't');
  s := replace(s, 'kh', 'h');
  s := replace(s, 'ck', 'k');
  s := regexp_replace(s, 'c(?=[a-gi-z])', 'k', 'g');      -- collagen -> kollagen (but keep "ch")
  s := regexp_replace(s, '([a-z])c(?![a-z])', '\1k', 'g'); -- zinc -> zink (a lone "c" = vitamin C stays)
  s := replace(s, 'q', 'k');
  s := replace(s, 'w', 'v');
  s := replace(s, 'x', 'ks');
  s := replace(s, 'ts', 'z');
  s := replace(s, 'y', 'i');

  s := regexp_replace(s, '[^a-z0-9]+', ' ', 'g');
  s := regexp_replace(s, '([a-z])\1+', '\1', 'g');          -- kollagen -> kolagen
  RETURN btrim(s);
END;
$$;

CREATE OR REPLACE FUNCTION vitalo_product_doc(name_ru text, name_uz text, brand text, keywords text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT vitalo_norm(coalesce(name_ru, '') || ' ' || coalesce(name_uz, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(keywords, ''))
$$;

CREATE INDEX products_search_doc_trgm ON products
  USING gin (vitalo_product_doc(name_ru, name_uz, brand, search_keywords) gin_trgm_ops);
