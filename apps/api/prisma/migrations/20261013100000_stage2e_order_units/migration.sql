-- Stage 2E: physical units for Mini App (VITALO) orders. Only adds: one nullable column, a table, indexes,
-- constraints and triggers; the unit status trigger gets the VITALO transitions. Existing rows are not changed.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "units_attention" TEXT;

-- CreateTable
CREATE TABLE "order_item_units" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "physical_unit_id" UUID NOT NULL,
    "assigned_by" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "picked_at" TIMESTAMP(3),
    "fefo_override" TEXT,
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,
    "return_decision" TEXT,
    "cost_snapshot_uzs" BIGINT,

    CONSTRAINT "order_item_units_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_item_units_order_id_idx" ON "order_item_units"("order_id");

-- CreateIndex
CREATE INDEX "order_item_units_physical_unit_id_idx" ON "order_item_units"("physical_unit_id");

-- AddForeignKey
ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_physical_unit_id_fkey" FOREIGN KEY ("physical_unit_id") REFERENCES "physical_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── rules Prisma cannot express ─────────────

ALTER TABLE "order_item_units" ADD CONSTRAINT "order_item_units_values_chk" CHECK (
  (return_decision IS NULL OR return_decision IN ('ACCEPTED', 'WRITTEN_OFF'))
  AND (cost_snapshot_uzs IS NULL OR cost_snapshot_uzs >= 0)
);

-- One physical unit belongs to at most one Mini App order at a time (released assignments stay as history)
CREATE UNIQUE INDEX "order_item_units_active_unit_key" ON "order_item_units" ("physical_unit_id") WHERE released_at IS NULL;

-- … and never to a Mini App order and a Yandex order at once (both directions)
CREATE OR REPLACE FUNCTION check_unit_not_in_other_channel() RETURNS trigger AS $$
BEGIN
  IF NEW.released_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'order_item_units' THEN
    IF EXISTS (SELECT 1 FROM marketplace_order_units WHERE physical_unit_id = NEW.physical_unit_id AND released_at IS NULL) THEN
      RAISE EXCEPTION 'the unit is already in a Yandex order';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM order_item_units WHERE physical_unit_id = NEW.physical_unit_id AND released_at IS NULL) THEN
      RAISE EXCEPTION 'the unit is already in a VITALO order';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER order_item_units_other_channel BEFORE INSERT ON "order_item_units" FOR EACH ROW EXECUTE FUNCTION check_unit_not_in_other_channel();
CREATE TRIGGER marketplace_order_units_other_channel BEFORE INSERT ON "marketplace_order_units" FOR EACH ROW EXECUTE FUNCTION check_unit_not_in_other_channel();

-- Assignments are never deleted; an assignment keeps its order, line and unit; once released it stays released
CREATE OR REPLACE FUNCTION forbid_order_item_unit_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_item_units rows cannot be deleted (release the unit instead)';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER order_item_units_no_delete BEFORE DELETE ON "order_item_units" FOR EACH ROW EXECUTE FUNCTION forbid_order_item_unit_delete();

CREATE OR REPLACE FUNCTION check_order_item_unit_update() RETURNS trigger AS $$
BEGIN
  IF NEW.order_id <> OLD.order_id OR NEW.order_item_id <> OLD.order_item_id OR NEW.physical_unit_id <> OLD.physical_unit_id THEN
    RAISE EXCEPTION 'an assignment keeps its order, line and unit';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'a released assignment cannot be taken back';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER order_item_units_update_chk BEFORE UPDATE ON "order_item_units" FOR EACH ROW EXECUTE FUNCTION check_order_item_unit_update();

-- Unit status: the 2C table plus the Mini App path (ASSIGNED -> VITALO_DELIVERY -> VITALO_SOLD, returns from both).
-- The service checks the same table (unit-lifecycle.ts).
CREATE OR REPLACE FUNCTION check_physical_unit_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status::text, NEW.status::text) IN (
    ('RECEIVED', 'IN_STOCK'), ('RECEIVED', 'VOIDED'),
    ('IN_STOCK', 'ASSIGNED'), ('ASSIGNED', 'IN_STOCK'),
    ('ASSIGNED', 'YANDEX_DELIVERY'), ('YANDEX_DELIVERY', 'YANDEX_SOLD'),
    ('YANDEX_DELIVERY', 'RETURNED'), ('YANDEX_SOLD', 'RETURNED'),
    ('ASSIGNED', 'VITALO_DELIVERY'), ('VITALO_DELIVERY', 'VITALO_SOLD'),
    ('VITALO_DELIVERY', 'RETURNED'), ('VITALO_SOLD', 'RETURNED'),
    ('RETURNED', 'IN_STOCK'), ('RETURNED', 'WRITTEN_OFF'), ('RETURNED', 'MISSING'),
    ('IN_STOCK', 'MISSING'), ('MISSING', 'IN_STOCK'),
    ('IN_STOCK', 'WRITTEN_OFF'), ('MISSING', 'WRITTEN_OFF'),
    ('WRITTEN_OFF', 'IN_STOCK'), ('WRITTEN_OFF', 'MISSING')
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'physical unit status % -> % is not allowed', OLD.status, NEW.status;
END; $$ LANGUAGE plpgsql;
