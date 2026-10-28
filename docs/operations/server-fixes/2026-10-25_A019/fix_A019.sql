-- VITALO: включить учёт по банкам для одного товара — OZN-A019 (банки пришли приёмкой по закупке, флажок не выставился).
-- Меняется ОДНО поле: products.unit_tracking = true у этого товара, плюс запись в журнал (audit_logs).
-- Банки, остатки и резервы НЕ трогаются.
-- Перед запуском обязательно сделать бэкап (см. ИНСТРУКЦИЯ.md, шаг «Бэкап»).
-- Запуск на сервере: psql -X -P pager=off -d vitalo -f /tmp/vitalo_fix_A019.sql
--
-- Защита: флажок ставится, только если остаток товара равен числу банок на полке (На складе + Зарезервирована)
-- и нет открытой сессии начального остатка. Если условие не выполнено, скрипт останавливается с ОШИБКОЙ
-- и отменяет всё (ROLLBACK) — в базе ничего не меняется. Повторный запуск ничего не меняет.

\set ON_ERROR_STOP on
-- Для другого товара поменяйте SKU только в следующей строке (и имя файла).
\set sku 'OZN-A019'

BEGIN;
SELECT set_config('vitalo.fix_sku', :'sku', true) AS sku_to_fix;

\echo
\echo '=== До изменения ==='
SELECT p.sku, p.unit_tracking,
       (SELECT coalesce(sum(actual_qty), 0) FROM inventory WHERE product_id = p.id) AS actual,
       (SELECT count(*) FROM physical_units WHERE product_id = p.id AND status IN ('IN_STOCK', 'ASSIGNED')) AS on_shelf
FROM products p WHERE p.sku = :'sku';

\echo
\echo '=== Изменение (ожидается: updated = 1, audit_rows = 1) ==='
WITH upd AS (
  UPDATE products p SET unit_tracking = true
  WHERE p.sku = :'sku' AND NOT p.unit_tracking
    AND (SELECT coalesce(sum(actual_qty), 0) FROM inventory WHERE product_id = p.id)
      = (SELECT count(*) FROM physical_units WHERE product_id = p.id AND status IN ('IN_STOCK', 'ASSIGNED'))
    AND NOT EXISTS (
      SELECT 1 FROM physical_units pu JOIN receiving_sessions rs ON rs.id = pu.receiving_session_id
      WHERE pu.product_id = p.id AND rs.type = 'OPENING_BALANCE' AND rs.status = 'OPEN')
  RETURNING p.id, p.sku
), aud AS (
  INSERT INTO audit_logs (id, staff_user_id, action, entity_type, entity_id, before_json, after_json)
  SELECT gen_random_uuid(), NULL, 'product.unit_tracking_fix', 'product', upd.id,
         '{"unit_tracking": false}'::jsonb,
         jsonb_build_object('unit_tracking', true, 'sku', upd.sku,
                            'reason', 'банки пришли приёмкой по закупке, признак учёта по банкам не выставился (ручное исправление 2026-10-25)')
  FROM upd
  RETURNING entity_id
)
SELECT (SELECT count(*) FROM upd) AS updated, (SELECT count(*) FROM aud) AS audit_rows;

-- Самопроверка: если флажок не включился, ошибка -> всё отменяется.
DO $$
DECLARE
  v_sku text := current_setting('vitalo.fix_sku');
BEGIN
  IF NOT coalesce((SELECT unit_tracking FROM products WHERE sku = v_sku), false) THEN
    RAISE EXCEPTION 'ОСТАНОВЛЕНО: % не изменён — товар не найден, остаток не равен числу банок или есть открытый начальный остаток. Ничего не сохранено.', v_sku;
  END IF;
  IF (SELECT count(*) FROM audit_logs a JOIN products p ON p.id = a.entity_id
      WHERE p.sku = v_sku AND a.action = 'product.unit_tracking_fix') <> 1 THEN
    RAISE EXCEPTION 'ОСТАНОВЛЕНО: по % в журнале не одна запись исправления. Ничего не сохранено.', v_sku;
  END IF;
END $$;

\echo
\echo '=== После изменения ==='
SELECT sku, unit_tracking FROM products WHERE sku = :'sku';

COMMIT;
\echo
\echo '=== ГОТОВО: товар переведён на учёт по банкам (см. «После изменения» выше). ==='
