-- Stage 2D: Yandex orders arrive by themselves (read only). Only adds: columns with defaults, two tables,
-- indexes, constraints and a trigger. Existing rows are not changed.

-- AlterTable
ALTER TABLE "marketplace_orders" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "stock_shortage" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "yandex_campaign_id" BIGINT,
ADD COLUMN     "yandex_status" TEXT,
ADD COLUMN     "yandex_substatus" TEXT,
ADD COLUMN     "yandex_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "marketplace_external_orders" (
    "id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL DEFAULT 'yandex',
    "external_number" TEXT NOT NULL,
    "campaign_id" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "substatus" TEXT,
    "yandex_updated_at" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "order_id" UUID,
    "attention_kind" TEXT,
    "attention_reason" TEXT,
    "attention_at" TIMESTAMP(3),
    "attention_notified_at" TIMESTAMP(3),
    "new_order_notified_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by" UUID,
    "close_reason" TEXT,
    "last_error" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_external_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "yandex_sync_runs" (
    "id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "found" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "attention" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "details" JSONB,
    "started_by" UUID,

    CONSTRAINT "yandex_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_external_orders_attention_at_idx" ON "marketplace_external_orders"("attention_at");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_external_orders_marketplace_external_number_key" ON "marketplace_external_orders"("marketplace", "external_number");

-- CreateIndex
CREATE INDEX "yandex_sync_runs_started_at_idx" ON "yandex_sync_runs"("started_at");

-- AddForeignKey
ALTER TABLE "marketplace_external_orders" ADD CONSTRAINT "marketplace_external_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "marketplace_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── rules Prisma cannot express ─────────────

ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_source_chk" CHECK (source IN ('manual', 'yandex_api'));
ALTER TABLE "marketplace_external_orders" ADD CONSTRAINT "marketplace_external_orders_closed_chk" CHECK (
  (closed_at IS NULL) = (close_reason IS NULL) AND (close_reason IS NULL OR char_length(btrim(close_reason)) >= 3)
);
ALTER TABLE "yandex_sync_runs" ADD CONSTRAINT "yandex_sync_runs_mode_chk" CHECK (mode IN ('DRY_RUN', 'LIVE') AND trigger IN ('schedule', 'manual', 'webhook'));

-- What the sync saw is history: never deleted (function from the stage 2C migration)
CREATE TRIGGER marketplace_external_orders_no_delete BEFORE DELETE ON "marketplace_external_orders" FOR EACH ROW EXECUTE FUNCTION forbid_marketplace_delete();
