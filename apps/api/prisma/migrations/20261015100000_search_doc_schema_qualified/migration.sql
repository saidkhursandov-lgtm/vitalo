-- Block E (S-E-11): vitalo_product_doc() called vitalo_norm() without the schema name. pg_restore works with an
-- empty search_path, so rebuilding the index products_search_doc_trgm from a backup failed with
-- «function vitalo_norm(text) does not exist» — a backup could not be restored completely.
-- Same function, same result; only the call is now written as public.vitalo_norm(). Changes no data; the index
-- stays valid (the expression gives the same values).
-- The same statement is in scripts/server/qualify-search-functions.sql (applied while restoring older copies).

CREATE OR REPLACE FUNCTION public.vitalo_product_doc(name_ru text, name_uz text, brand text, keywords text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.vitalo_norm(coalesce(name_ru, '') || ' ' || coalesce(name_uz, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(keywords, ''))
$$;
