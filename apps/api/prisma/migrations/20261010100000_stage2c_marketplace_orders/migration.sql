-- Stage 2C: Yandex Market orders and the life cycle of physical units. Only adds: enums, tables, indexes,
-- constraints and triggers. Existing rows (units, stock, VITALO orders) are not changed.

-- CreateEnum
CREATE TYPE "marketplace" AS ENUM ('yandex');

-- CreateEnum
CREATE TYPE "marketplace_order_status" AS ENUM ('NEW', 'ASSEMBLED', 'HANDED_TO_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED');

-- CreateTable
CREATE TABLE "marketplace_orders" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL DEFAULT 'yandex',
    "external_number" TEXT NOT NULL,
    "order_date" DATE NOT NULL,
    "customer_name" TEXT,
    "status" "marketplace_order_status" NOT NULL DEFAULT 'NEW',
    "commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 18.5,
    "note" TEXT,
    "cancel_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "assembled_at" TIMESTAMP(3),
    "handed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "marketplace_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price_uzs" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_order_units" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "physical_unit_id" UUID NOT NULL,
    "assigned_by" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "picked_at" TIMESTAMP(3),
    "fefo_override" TEXT,
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,
    "return_decision" TEXT,

    CONSTRAINT "marketplace_order_units_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_orders_status_order_date_idx" ON "marketplace_orders"("status", "order_date");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_orders_marketplace_external_number_key" ON "marketplace_orders"("marketplace", "external_number");

-- CreateIndex
CREATE INDEX "marketplace_order_lines_product_id_idx" ON "marketplace_order_lines"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_order_lines_order_id_position_key" ON "marketplace_order_lines"("order_id", "position");

-- CreateIndex
CREATE INDEX "marketplace_order_units_order_id_idx" ON "marketplace_order_units"("order_id");

-- CreateIndex
CREATE INDEX "marketplace_order_units_physical_unit_id_idx" ON "marketplace_order_units"("physical_unit_id");

-- AddForeignKey
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_lines" ADD CONSTRAINT "marketplace_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "marketplace_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_lines" ADD CONSTRAINT "marketplace_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_units" ADD CONSTRAINT "marketplace_order_units_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "marketplace_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_units" ADD CONSTRAINT "marketplace_order_units_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "marketplace_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_units" ADD CONSTRAINT "marketplace_order_units_physical_unit_id_fkey" FOREIGN KEY ("physical_unit_id") REFERENCES "physical_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── rules Prisma cannot express ─────────────

ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_values_chk" CHECK (
  char_length(btrim(external_number)) BETWEEN 1 AND 64 AND commission_percent >= 0 AND commission_percent < 100
);
ALTER TABLE "marketplace_order_lines" ADD CONSTRAINT "marketplace_order_lines_values_chk" CHECK (qty > 0 AND unit_price_uzs >= 0 AND position > 0);
ALTER TABLE "marketplace_order_units" ADD CONSTRAINT "marketplace_order_units_decision_chk" CHECK (
  return_decision IS NULL OR return_decision IN ('ACCEPTED', 'WRITTEN_OFF')
);

-- One physical unit belongs to at most one order at a time (released assignments stay as history)
CREATE UNIQUE INDEX "marketplace_order_units_active_unit_key" ON "marketplace_order_units" ("physical_unit_id") WHERE released_at IS NULL;

-- Orders, lines and assignments are never deleted
CREATE OR REPLACE FUNCTION forbid_marketplace_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted (cancel the order instead)', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER marketplace_orders_no_delete BEFORE DELETE ON "marketplace_orders" FOR EACH ROW EXECUTE FUNCTION forbid_marketplace_delete();
CREATE TRIGGER marketplace_order_lines_no_delete BEFORE DELETE ON "marketplace_order_lines" FOR EACH ROW EXECUTE FUNCTION forbid_marketplace_delete();
CREATE TRIGGER marketplace_order_units_no_delete BEFORE DELETE ON "marketplace_order_units" FOR EACH ROW EXECUTE FUNCTION forbid_marketplace_delete();

-- An assignment keeps its order, line and unit; once released it stays released
CREATE OR REPLACE FUNCTION check_marketplace_assignment_update() RETURNS trigger AS $$
BEGIN
  IF NEW.order_id <> OLD.order_id OR NEW.line_id <> OLD.line_id OR NEW.physical_unit_id <> OLD.physical_unit_id THEN
    RAISE EXCEPTION 'an assignment keeps its order, line and unit';
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'a released assignment cannot be taken back';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER marketplace_order_units_update_chk BEFORE UPDATE ON "marketplace_order_units" FOR EACH ROW EXECUTE FUNCTION check_marketplace_assignment_update();

-- Order status: NEW -> ASSEMBLED -> HANDED_TO_DELIVERY -> DELIVERED; NEW/ASSEMBLED -> CANCELLED;
-- HANDED_TO_DELIVERY/DELIVERED -> RETURNED. CANCELLED and RETURNED are final.
CREATE OR REPLACE FUNCTION check_marketplace_order_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (
    ('NEW', 'ASSEMBLED'), ('ASSEMBLED', 'HANDED_TO_DELIVERY'), ('HANDED_TO_DELIVERY', 'DELIVERED'),
    ('NEW', 'CANCELLED'), ('ASSEMBLED', 'CANCELLED'), ('HANDED_TO_DELIVERY', 'RETURNED'), ('DELIVERED', 'RETURNED')
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'marketplace order status % -> % is not allowed', OLD.status, NEW.status;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER marketplace_orders_status_chk BEFORE UPDATE OF status ON "marketplace_orders" FOR EACH ROW EXECUTE FUNCTION check_marketplace_order_status();

-- Unit status: only these transitions (the service checks the same table, see unit-lifecycle.ts).
-- VITALO_DELIVERY / VITALO_SOLD come with stage 2E. Admin corrections: between IN_STOCK, MISSING, WRITTEN_OFF
-- and from RETURNED to MISSING (units of an order move only with the order).
CREATE OR REPLACE FUNCTION check_physical_unit_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status::text, NEW.status::text) IN (
    ('RECEIVED', 'IN_STOCK'), ('RECEIVED', 'VOIDED'),
    ('IN_STOCK', 'ASSIGNED'), ('ASSIGNED', 'IN_STOCK'),
    ('ASSIGNED', 'YANDEX_DELIVERY'), ('YANDEX_DELIVERY', 'YANDEX_SOLD'),
    ('YANDEX_DELIVERY', 'RETURNED'), ('YANDEX_SOLD', 'RETURNED'),
    ('RETURNED', 'IN_STOCK'), ('RETURNED', 'WRITTEN_OFF'), ('RETURNED', 'MISSING'),
    ('IN_STOCK', 'MISSING'), ('MISSING', 'IN_STOCK'),
    ('IN_STOCK', 'WRITTEN_OFF'), ('MISSING', 'WRITTEN_OFF'),
    ('WRITTEN_OFF', 'IN_STOCK'), ('WRITTEN_OFF', 'MISSING')
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'physical unit status % -> % is not allowed', OLD.status, NEW.status;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER physical_units_status_chk BEFORE UPDATE OF status ON "physical_units" FOR EACH ROW EXECUTE FUNCTION check_physical_unit_status();
