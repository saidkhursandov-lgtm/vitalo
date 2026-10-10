-- Stage 3: expenses, turnover tax, payroll, test flag and own delivery cost of orders. Only adds: columns with
-- defaults, tables, indexes and constraints. Existing rows are not changed.

-- AlterTable
ALTER TABLE "marketplace_orders" ADD COLUMN     "is_test" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "own_delivery_cost_uzs" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "marketplace_order_units" ADD COLUMN     "cost_snapshot_uzs" BIGINT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "is_test" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "own_delivery_cost_uzs" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "spent_on" DATE NOT NULL,
    "category_id" UUID NOT NULL,
    "amount_uzs" BIGINT NOT NULL,
    "comment" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "delete_reason" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_payments" (
    "month" TEXT NOT NULL,
    "paid_on" DATE NOT NULL,
    "paid_amount_uzs" BIGINT NOT NULL,
    "turnover_uzs" BIGINT NOT NULL,
    "rate_percent" DECIMAL(5,2) NOT NULL,
    "tax_uzs" BIGINT NOT NULL,
    "paid_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_payments_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "payroll_employees" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_month" TEXT NOT NULL,
    "end_month" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_rates" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "from_month" TEXT NOT NULL,
    "amount_uzs" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "paid_on" DATE NOT NULL,
    "amount_uzs" BIGINT NOT NULL,
    "paid_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_reminders" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_name_key" ON "expense_categories"("name");

-- CreateIndex
CREATE INDEX "expenses_spent_on_idx" ON "expenses"("spent_on");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_rates_employee_id_from_month_key" ON "payroll_rates"("employee_id", "from_month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payments_employee_id_month_key" ON "payroll_payments"("employee_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "finance_reminders_kind_day_key" ON "finance_reminders"("kind", "day");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── rules Prisma cannot express ─────────────

ALTER TABLE "orders" ADD CONSTRAINT "orders_own_delivery_chk" CHECK (own_delivery_cost_uzs >= 0);
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_own_delivery_chk" CHECK (own_delivery_cost_uzs >= 0);
ALTER TABLE "marketplace_order_units" ADD CONSTRAINT "marketplace_order_units_cost_chk" CHECK (cost_snapshot_uzs IS NULL OR cost_snapshot_uzs >= 0);

ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_name_chk" CHECK (char_length(btrim(name)) BETWEEN 1 AND 60);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_values_chk" CHECK (
  amount_uzs > 0 AND ((deleted_at IS NULL) = (delete_reason IS NULL))
);

-- months are written as YYYY-MM
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_values_chk" CHECK (
  month ~ '^\d{4}-(0[1-9]|1[0-2])$' AND paid_amount_uzs >= 0 AND turnover_uzs >= 0 AND tax_uzs >= 0 AND rate_percent >= 0 AND rate_percent < 100
);
ALTER TABLE "payroll_employees" ADD CONSTRAINT "payroll_employees_values_chk" CHECK (
  char_length(btrim(name)) BETWEEN 1 AND 100 AND start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'
  AND (end_month IS NULL OR (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$' AND end_month >= start_month))
);
ALTER TABLE "payroll_rates" ADD CONSTRAINT "payroll_rates_values_chk" CHECK (from_month ~ '^\d{4}-(0[1-9]|1[0-2])$' AND amount_uzs >= 0);
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_values_chk" CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$' AND amount_uzs >= 0);
ALTER TABLE "finance_reminders" ADD CONSTRAINT "finance_reminders_kind_chk" CHECK (kind IN ('before_due', 'due_day'));
