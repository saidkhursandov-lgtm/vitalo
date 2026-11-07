-- D-54 (08.11.2026, owner's decision): «Удалить» in the admin erases a product or a brand that has no history.
-- The delete protection stays: a DELETE is refused unless the API itself switched it off for one transaction
-- (SET LOCAL vitalo.allow_delete = 'on'), which only the admin «Удалить» buttons do. Nothing is dropped.

CREATE OR REPLACE FUNCTION forbid_product_delete() RETURNS trigger AS $$
BEGIN
  IF current_setting('vitalo.allow_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'products cannot be deleted; set status = archived';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_dictionary_delete() RETURNS trigger AS $$
BEGIN
  IF current_setting('vitalo.allow_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'dictionary values cannot be deleted; set status = archived';
END; $$ LANGUAGE plpgsql;
