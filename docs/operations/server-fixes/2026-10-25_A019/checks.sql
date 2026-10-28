-- VITALO: проверка OZN-A019 и других товаров «банки есть, учёта по банкам нет».
-- ТОЛЬКО ЧТЕНИЕ: всё выполняется в транзакции READ ONLY и в конце отменяется (ROLLBACK).
-- Запуск на сервере: psql -X -P pager=off -d vitalo -f /tmp/vitalo_checks.sql

\set ON_ERROR_STOP on
BEGIN READ ONLY;

\echo
\echo '=== 1. Флажок учёта по банкам и остаток: A019 против рабочих A014 / A006 ==='
SELECT p.sku, p.unit_tracking, p.status,
       (SELECT sum(actual_qty)   FROM inventory i WHERE i.product_id = p.id) AS actual,
       (SELECT sum(reserved_qty) FROM inventory i WHERE i.product_id = p.id) AS reserved
FROM products p
WHERE p.sku IN ('OZN-A019', 'OZN-A014', 'OZN-A006')
ORDER BY p.sku;

\echo
\echo '=== 2. Откуда банки: тип и статус приёмки ==='
SELECT p.sku, rs.type AS session_type, rs.status AS session_status, rs.completed_at,
       pu.status AS unit_status, count(*) AS units,
       min(pu.physical_id) AS first_id, max(pu.physical_id) AS last_id
FROM physical_units pu
JOIN products p ON p.id = pu.product_id
LEFT JOIN receiving_sessions rs ON rs.id = pu.receiving_session_id
WHERE p.sku IN ('OZN-A019', 'OZN-A014', 'OZN-A006')
GROUP BY p.sku, rs.type, rs.status, rs.completed_at, pu.status
ORDER BY p.sku, rs.completed_at;

\echo
\echo '=== 3. Движения остатка OZN-A019 ==='
SELECT m.created_at, m.movement_type, m.qty, m.reference_type, m.reason
FROM inventory_movements m
JOIN products p ON p.id = m.product_id
WHERE p.sku = 'OZN-A019'
ORDER BY m.created_at;

\echo
\echo '=== 4. Все товары с той же проблемой: банки есть, флажка нет ==='
\echo '    can_fix = да: остаток равен банкам на полке, открытого начального остатка нет'
SELECT p.sku,
       count(*) FILTER (WHERE pu.status IN ('IN_STOCK', 'ASSIGNED')) AS on_shelf,
       (SELECT coalesce(sum(actual_qty), 0) FROM inventory i WHERE i.product_id = p.id) AS actual,
       (SELECT coalesce(sum(reserved_qty), 0) FROM inventory i WHERE i.product_id = p.id) AS reserved,
       string_agg(DISTINCT rs.type || '/' || rs.status, ', ') AS sessions,
       CASE WHEN count(*) FILTER (WHERE pu.status IN ('IN_STOCK', 'ASSIGNED'))
                 = (SELECT coalesce(sum(actual_qty), 0) FROM inventory i WHERE i.product_id = p.id)
             AND NOT bool_or(rs.type = 'OPENING_BALANCE' AND rs.status = 'OPEN')
            THEN 'да' ELSE 'НЕТ' END AS can_fix
FROM products p
JOIN physical_units pu ON pu.product_id = p.id
JOIN receiving_sessions rs ON rs.id = pu.receiving_session_id
WHERE NOT p.unit_tracking
GROUP BY p.id, p.sku
HAVING count(*) FILTER (WHERE pu.status IN ('IN_STOCK', 'ASSIGNED')) > 0
ORDER BY p.sku;

\echo
\echo '=== 5. Автозаказ Яндекса 63529814338 ==='
SELECT external_number, status, substatus, attention_kind, attention_reason, attention_at,
       order_id IS NOT NULL AS order_created, closed_at, last_error
FROM marketplace_external_orders
WHERE external_number = '63529814338';

ROLLBACK;
\echo
\echo '=== Готово. Ничего не изменено. ==='
