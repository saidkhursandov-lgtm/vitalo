-- Shipping label of a Mini App order: the optional waybill number of the delivery service (BTS, Yandex Go…).
-- Only adds one empty column; existing orders keep NULL. No data is changed.
ALTER TABLE "orders" ADD COLUMN "delivery_waybill" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_waybill_check"
  CHECK ("delivery_waybill" IS NULL OR (char_length("delivery_waybill") BETWEEN 1 AND 64 AND "delivery_waybill" = btrim("delivery_waybill")));
