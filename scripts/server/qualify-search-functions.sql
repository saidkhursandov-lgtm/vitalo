-- Applied by lib-restore.sh between the structure and the data of a copy (S-E-11): copies made before the
-- migration 20261015100000_search_doc_schema_qualified hold vitalo_product_doc() that calls vitalo_norm() without
-- the schema name, and the search index of products cannot be rebuilt from them. Same function, same result.
-- Does nothing when the copy has no such function (a very old copy).
DO $do$
BEGIN
  IF to_regprocedure('public.vitalo_product_doc(text, text, text, text)') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.vitalo_product_doc(name_ru text, name_uz text, brand text, keywords text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT public.vitalo_norm(coalesce(name_ru, '') || ' ' || coalesce(name_uz, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(keywords, ''))
    $$;
  END IF;
END
$do$;
