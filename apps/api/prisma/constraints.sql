-- Apply after `prisma migrate` (put into a custom migration).
-- Constraints that Prisma schema cannot express.

-- Inventory: never negative, reserved never exceeds actual (concurrency safety net)
ALTER TABLE inventory
  ADD CONSTRAINT inventory_qty_chk CHECK (actual_qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= actual_qty);

-- Convenience view: available = actual - reserved
CREATE OR REPLACE VIEW inventory_available AS
  SELECT product_id, warehouse_id, actual_qty, reserved_qty, (actual_qty - reserved_qty) AS available_qty
  FROM inventory;

-- Bonus balance never negative
ALTER TABLE bonus_accounts ADD CONSTRAINT bonus_balance_chk CHECK (balance_uzs >= 0);

-- One primary address per user
CREATE UNIQUE INDEX addresses_one_primary ON addresses (user_id)
  WHERE is_primary = true AND deleted_at IS NULL;

-- One active cart per user
CREATE UNIQUE INDEX carts_one_active ON carts (user_id) WHERE status = 'active';

-- Max 3 levels of category tree is enforced in the application (service layer) + check on insert:
-- depth(parent) <= 2. See CategoriesService.

-- Immutable bonus ledger
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bonus_ledger is immutable; use a reversal operation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER bonus_ledger_immutable
  BEFORE UPDATE OR DELETE ON bonus_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Products are never physically deleted
CREATE OR REPLACE FUNCTION forbid_product_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'products cannot be deleted; set status = archived';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER products_no_delete
  BEFORE DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION forbid_product_delete();

-- Typo-tolerant search (pg_trgm)
CREATE INDEX products_name_trgm ON products USING gin (lower(name_ru) gin_trgm_ops);
CREATE INDEX products_brand_trgm ON products USING gin (lower(brand) gin_trgm_ops);
CREATE INDEX products_kw_trgm ON products USING gin (lower(coalesce(search_keywords,'')) gin_trgm_ops);
