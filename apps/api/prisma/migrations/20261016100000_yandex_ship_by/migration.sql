-- «Отгрузить до» of a Yandex order (delivery.shipment of the Yandex answer): the date and, when given, the time.
-- Only adds two empty columns; existing orders keep NULL («срок не указан»). No data is changed.
ALTER TABLE "marketplace_orders" ADD COLUMN "ship_by_date" DATE;
ALTER TABLE "marketplace_orders" ADD COLUMN "ship_by_time" TEXT;
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_ship_by_time_check"
  CHECK ("ship_by_time" IS NULL OR ("ship_by_date" IS NOT NULL AND "ship_by_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
