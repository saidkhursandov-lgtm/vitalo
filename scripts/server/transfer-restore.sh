#!/usr/bin/env bash
# The move, step 1 of 2 (docs/DEPLOY_RUNBOOK.md, phase 3): restores the copy of the development database into a
# NEW database `vitalo_new` next to the working one. The working database `vitalo` and the services are not touched,
# the shop keeps running. Run on the server through sudo:
#   sudo /opt/vitalo/app/scripts/server/transfer-restore.sh /opt/vitalo/import/vitalo_dev-for-server-….dump
# Then look at the numbers it prints. Step 2: transfer-swap.sh
set -euo pipefail
cd / # sudo -u vitalo / postgres must be able to enter the current folder

NEW_DB=vitalo_new
DB_NAME=${DB_NAME:-vitalo}
DUMP=${1:-}

if [ "$(id -u)" != "0" ]; then
  echo "Запустите через sudo:  sudo $0 $*" >&2
  exit 1
fi
if [ -z "$DUMP" ] || ! sudo -u vitalo test -r "$DUMP"; then
  echo "Укажите файл копии, который может прочитать пользователь vitalo, например:" >&2
  echo "  $0 /opt/vitalo/import/vitalo_dev-for-server-20261020-1200.dump" >&2
  exit 1
fi
if ! sudo -u vitalo pg_restore --list "$DUMP" >/dev/null; then
  echo "Файл не читается как копия базы (возможно, передался не полностью). Ничего не сделано." >&2
  exit 1
fi
if [ "$(sudo -u postgres psql -X -At -c "SELECT 1 FROM pg_database WHERE datname = '$NEW_DB'")" = "1" ]; then
  echo "База $NEW_DB уже есть (осталась от прошлой попытки). Если она не нужна, удалите её и запустите снова:" >&2
  echo "  sudo -u postgres dropdb $NEW_DB" >&2
  exit 1
fi

q() { sudo -u vitalo psql -X -At -d "$1" -c "$2" 2>/dev/null || echo "нет"; }

echo "1/3 Новая пустая база $NEW_DB (рабочая база $DB_NAME не меняется)"
sudo -u postgres createdb -O vitalo "$NEW_DB"
sudo -u postgres psql -X -q -d "$NEW_DB" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;'

echo "2/3 Восстановление копии: $DUMP ($(sudo -u vitalo du -h "$DUMP" | cut -f1))"
if ! sudo -u vitalo pg_restore --no-owner --no-acl --exit-on-error -d "$NEW_DB" "$DUMP"; then
  echo "ОШИБКА восстановления. Рабочая база не тронута. Удалите неполную базу: sudo -u postgres dropdb $NEW_DB" >&2
  exit 1
fi

echo "3/3 Что в новой базе и что сейчас в рабочей"
printf '    %-34s %12s %12s\n' "" "новая" "рабочая"
row() { printf '    %-34s %12s %12s\n' "$1" "$(q "$NEW_DB" "$2")" "$(q "$DB_NAME" "$2")"; }
row "товаров"                    "SELECT count(*) FROM products"
row "банок (Physical ID)"        "SELECT count(*) FROM physical_units"
row "банок на полке"             "SELECT count(*) FROM physical_units WHERE status IN ('IN_STOCK','ASSIGNED')"
row "остаток по количеству"      "SELECT coalesce(sum(actual_qty),0) FROM inventory"
row "альтернативных SKU"         "SELECT count(*) FROM product_sku_aliases"
row "заказов VITALO"             "SELECT count(*) FROM orders"
row "  из них с пометкой «тест»" "SELECT count(*) FROM orders WHERE is_test"
row "заказов Яндекса"            "SELECT count(*) FROM marketplace_orders"
row "  из них с пометкой «тест»" "SELECT count(*) FROM marketplace_orders WHERE is_test"
row "покупателей"                "SELECT count(*) FROM users"
row "сотрудников"                "SELECT count(*) FROM staff_users"
row "миграций применено"         "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL"
echo "    («нет» в правой колонке — в рабочей базе ещё нет такой таблицы или колонки: это нормально для старой версии)"
echo "    последняя миграция в новой базе: $(q "$NEW_DB" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1 DESC LIMIT 1")"
echo
echo "Сверьте левую колонку с тем, что показывает админка на вашем компьютере (Склад → Единицы, Товары)."
echo "Если всё совпадает — шаг 2: sudo $(dirname "$(readlink -f "$0")")/transfer-swap.sh"
echo "Передумали: sudo -u postgres dropdb $NEW_DB"
