-- Stage 2B: physical units (Physical ID), receiving, labels. Only adds: enums, a sequence, tables, columns,
-- indexes, constraints and triggers. purchase_lines.position is filled from created_at for the existing lines.
-- Stock, orders and the existing rows of other tables are not changed.

-- CreateEnum
CREATE TYPE "physical_unit_status" AS ENUM ('RECEIVED', 'IN_STOCK', 'ASSIGNED', 'YANDEX_DELIVERY', 'YANDEX_SOLD', 'VITALO_DELIVERY', 'VITALO_SOLD', 'RETURNED', 'MISSING', 'WRITTEN_OFF', 'VOIDED');

-- CreateEnum
CREATE TYPE "receiving_session_type" AS ENUM ('PURCHASE', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "receiving_session_status" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "label_composition_ru" TEXT,
ADD COLUMN     "label_composition_uz" TEXT,
ADD COLUMN     "unit_tracking" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "purchase_lines" ADD COLUMN     "position" INTEGER;

-- Existing lines: the order they were entered in (created_at, then id), 1, 2, … per purchase
UPDATE "purchase_lines" l SET "position" = n.rn
FROM (SELECT id, row_number() OVER (PARTITION BY purchase_id ORDER BY created_at, id) AS rn FROM "purchase_lines") n
WHERE l.id = n.id;
ALTER TABLE "purchase_lines" ALTER COLUMN "position" SET NOT NULL;

-- CreateTable
CREATE TABLE "physical_units" (
    "id" UUID NOT NULL,
    "physical_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "purchase_id" UUID,
    "purchase_line_id" UUID,
    "receiving_session_id" UUID NOT NULL,
    "actual_cost_uzs" BIGINT NOT NULL,
    "expiry_date" DATE NOT NULL,
    "status" "physical_unit_status" NOT NULL DEFAULT 'RECEIVED',
    "label_print_count" INTEGER NOT NULL DEFAULT 0,
    "last_printed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "physical_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_unit_events" (
    "id" UUID NOT NULL,
    "physical_unit_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "physical_unit_status",
    "to_status" "physical_unit_status",
    "reference_type" TEXT,
    "reference_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "physical_unit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving_sessions" (
    "id" UUID NOT NULL,
    "type" "receiving_session_type" NOT NULL,
    "purchase_id" UUID,
    "ozon_account_id" UUID,
    "supplier_id" UUID,
    "status" "receiving_session_status" NOT NULL DEFAULT 'OPEN',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "completion_key" TEXT,

    CONSTRAINT "receiving_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving_session_lines" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "purchase_line_id" UUID,
    "qty" INTEGER NOT NULL,
    "expiry_date_groups" JSONB NOT NULL,
    "discrepancy_qty" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_session_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "physical_units_physical_id_key" ON "physical_units"("physical_id");

-- CreateIndex
CREATE UNIQUE INDEX "physical_units_seq_key" ON "physical_units"("seq");

-- CreateIndex
CREATE INDEX "physical_units_product_id_status_expiry_date_seq_idx" ON "physical_units"("product_id", "status", "expiry_date", "seq");

-- CreateIndex
CREATE INDEX "physical_units_status_idx" ON "physical_units"("status");

-- CreateIndex
CREATE INDEX "physical_units_receiving_session_id_idx" ON "physical_units"("receiving_session_id");

-- CreateIndex
CREATE INDEX "physical_units_purchase_line_id_idx" ON "physical_units"("purchase_line_id");

-- CreateIndex
CREATE INDEX "physical_unit_events_physical_unit_id_created_at_idx" ON "physical_unit_events"("physical_unit_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "receiving_sessions_completion_key_key" ON "receiving_sessions"("completion_key");

-- CreateIndex
CREATE INDEX "receiving_sessions_status_created_at_idx" ON "receiving_sessions"("status", "created_at");

-- CreateIndex
CREATE INDEX "receiving_session_lines_session_id_idx" ON "receiving_session_lines"("session_id");

-- CreateIndex
CREATE INDEX "receiving_session_lines_purchase_line_id_idx" ON "receiving_session_lines"("purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_lines_purchase_id_position_key" ON "purchase_lines"("purchase_id", "position");

-- AddForeignKey
ALTER TABLE "physical_units" ADD CONSTRAINT "physical_units_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_units" ADD CONSTRAINT "physical_units_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_units" ADD CONSTRAINT "physical_units_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_units" ADD CONSTRAINT "physical_units_receiving_session_id_fkey" FOREIGN KEY ("receiving_session_id") REFERENCES "receiving_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_unit_events" ADD CONSTRAINT "physical_unit_events_physical_unit_id_fkey" FOREIGN KEY ("physical_unit_id") REFERENCES "physical_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_unit_events" ADD CONSTRAINT "physical_unit_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_ozon_account_id_fkey" FOREIGN KEY ("ozon_account_id") REFERENCES "ozon_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_session_lines" ADD CONSTRAINT "receiving_session_lines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "receiving_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_session_lines" ADD CONSTRAINT "receiving_session_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_session_lines" ADD CONSTRAINT "receiving_session_lines_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── rules Prisma cannot express ─────────────

-- Physical ID numbers: never reset, never reused (gaps after a rollback are fine)
CREATE SEQUENCE "physical_unit_seq" START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;

-- physical_id = «V-» + seq with zeros to 6 digits (V-000184); longer numbers as they are (V-1000000)
ALTER TABLE "physical_units" ADD CONSTRAINT "physical_units_physical_id_chk" CHECK (
  seq > 0 AND physical_id = 'V-' || CASE WHEN seq < 1000000 THEN lpad(seq::text, 6, '0') ELSE seq::text END
);
ALTER TABLE "physical_units" ADD CONSTRAINT "physical_units_values_chk" CHECK (actual_cost_uzs >= 0 AND label_print_count >= 0);

-- A unit is never deleted, and its number never changes (cancelled receiving -> status VOIDED)
CREATE OR REPLACE FUNCTION forbid_physical_unit_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'physical_units cannot be deleted; set status = VOIDED';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER physical_units_no_delete BEFORE DELETE ON "physical_units" FOR EACH ROW EXECUTE FUNCTION forbid_physical_unit_delete();

CREATE OR REPLACE FUNCTION forbid_physical_id_change() RETURNS trigger AS $$
BEGIN
  IF NEW.physical_id <> OLD.physical_id OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'physical_id and seq of a unit never change';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER physical_units_id_fixed BEFORE UPDATE ON "physical_units" FOR EACH ROW EXECUTE FUNCTION forbid_physical_id_change();

-- The unit history is append-only (like purchase_events)
CREATE OR REPLACE FUNCTION forbid_physical_unit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'physical_unit_events is append-only';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER physical_unit_events_immutable BEFORE UPDATE OR DELETE ON "physical_unit_events" FOR EACH ROW EXECUTE FUNCTION forbid_physical_unit_event_mutation();

-- PURCHASE: exactly one source (Ozon account or supplier); OPENING_BALANCE: no source and no purchase
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_source_chk" CHECK (
  (type = 'PURCHASE' AND (ozon_account_id IS NULL) <> (supplier_id IS NULL))
  OR (type = 'OPENING_BALANCE' AND ozon_account_id IS NULL AND supplier_id IS NULL AND purchase_id IS NULL)
);
ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_completed_chk" CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL));

-- Not more than one OPEN session per purchase, per source, and one OPEN opening balance
CREATE UNIQUE INDEX "receiving_sessions_open_purchase_key" ON "receiving_sessions" ("purchase_id") WHERE status = 'OPEN' AND purchase_id IS NOT NULL;
CREATE UNIQUE INDEX "receiving_sessions_open_ozon_key" ON "receiving_sessions" ("ozon_account_id") WHERE status = 'OPEN' AND ozon_account_id IS NOT NULL;
CREATE UNIQUE INDEX "receiving_sessions_open_supplier_key" ON "receiving_sessions" ("supplier_id") WHERE status = 'OPEN' AND supplier_id IS NOT NULL;
CREATE UNIQUE INDEX "receiving_sessions_open_opening_key" ON "receiving_sessions" ("type") WHERE status = 'OPEN' AND type = 'OPENING_BALANCE';

ALTER TABLE "receiving_session_lines" ADD CONSTRAINT "receiving_session_lines_qty_chk" CHECK (qty > 0 AND (discrepancy_qty IS NULL OR discrepancy_qty > 0));
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_position_chk" CHECK (position > 0);

-- The short label composition is short
ALTER TABLE "products" ADD CONSTRAINT "products_label_composition_chk" CHECK (
  (label_composition_ru IS NULL OR char_length(label_composition_ru) <= 300)
  AND (label_composition_uz IS NULL OR char_length(label_composition_uz) <= 300)
);
