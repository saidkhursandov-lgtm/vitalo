#!/usr/bin/env bash
# Proves that a backup can really be restored. Run on the server through sudo:
#   sudo /opt/vitalo/app/scripts/server/restore-check.sh                 -> the newest copy in /var/backups/vitalo
#   sudo /opt/vitalo/app/scripts/server/restore-check.sh /path/db-….dump -> this copy
# It restores the copy into a TEMPORARY database (vitalo_restore_check), compares the number of rows in the main
# tables with the working database and deletes the temporary database. The working database is only read.
set -euo pipefail
cd / # sudo -u vitalo / postgres must be able to enter the current folder

. "$(dirname "$(readlink -f "$0")")/lib-restore.sh"

DIR=${BACKUP_DIR:-/var/backups/vitalo}
DB_NAME=${DB_NAME:-vitalo}
TMP_DB=vitalo_restore_check
TABLES="products physical_units physical_unit_events inventory orders marketplace_orders staff_users _prisma_migrations"
struct() { # database, query -> number
  sudo -u vitalo psql -X -At -d "$1" -c "$2" 2>/dev/null || echo "нет"
}

if [ "$(id -u)" != "0" ]; then
  echo "Запустите через sudo:  sudo $0 $*" >&2
  exit 1
fi

DUMP=${1:-}
if [ -z "$DUMP" ]; then
  DUMP=$(sudo -u vitalo bash -c "ls -1t $DIR/db-*.dump 2>/dev/null | head -n 1")
fi
if [ -z "$DUMP" ] || ! sudo -u vitalo test -r "$DUMP"; then
  echo "Не найдена копия базы (искал: ${DUMP:-$DIR/db-*.dump})." >&2
  exit 1
fi
echo "Копия: $DUMP ($(sudo -u vitalo du -h "$DUMP" | cut -f1))"

count() { # database, table -> number of rows
  sudo -u vitalo psql -X -At -d "$1" -c "SELECT count(*) FROM \"$2\"" 2>/dev/null || echo "нет"
}
drop_tmp() {
  sudo -u postgres dropdb --if-exists "$TMP_DB"
}
trap drop_tmp EXIT

echo "1/3 Временная база $TMP_DB"
drop_tmp
sudo -u postgres createdb -O vitalo "$TMP_DB"

echo "2/3 Восстановление копии во временную базу (рабочая база не меняется)"
if ! restore_into "$TMP_DB" "$DUMP"; then
  echo "ПЛОХО: копия не восстанавливается целиком (текст ошибки выше). Этой копии доверять нельзя." >&2
  exit 1
fi

echo "3/3 Сравнение (копия старше рабочей базы, поэтому в рабочей строк может быть немного больше)"
printf '    %-24s %12s %12s\n' "таблица" "в копии" "сейчас"
BAD=0
for t in $TABLES; do
  a=$(count "$TMP_DB" "$t")
  b=$(count "$DB_NAME" "$t")
  printf '    %-24s %12s %12s\n' "$t" "$a" "$b"
  if [ "$a" = "нет" ]; then BAD=1; fi
done

# what protects the data must come back too, not only the rows
for pair in "триггеры|SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal" "индексы|SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'"; do
  a=$(struct "$TMP_DB" "${pair#*|}")
  b=$(struct "$DB_NAME" "${pair#*|}")
  printf '    %-24s %12s %12s\n' "${pair%%|*}" "$a" "$b"
  if [ "$a" != "$b" ]; then
    echo "    ВНИМАНИЕ: ${pair%%|*} — в копии $a, в рабочей базе $b (после обновления с миграциями это нормально, иначе спросите)"
  fi
done

if [ "$BAD" = "1" ]; then
  echo "ПЛОХО: в копии нет части таблиц. Этой копии доверять нельзя." >&2
  exit 1
fi
echo "ХОРОШО: копия восстанавливается. Временная база удалена."
