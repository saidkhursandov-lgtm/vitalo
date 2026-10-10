#!/usr/bin/env bash
# Backup of the shop. Run as the `vitalo` user (the timer vitalo-backup.timer does it every night at 03:30).
#   backup.sh       -> database + product photos + a copy of the settings file (.env)
#   backup.sh db    -> database only (update.sh does this before every update)
# Files: /var/backups/vitalo (only the vitalo user can read it), kept KEEP_DAYS days (14 by default).
# Every database copy is checked right away (pg_restore can read its table of contents), otherwise the script fails.
# Copy the files off the server regularly: docs/DEPLOY_RUNBOOK.md, phase 7.
# Restore check on a temporary database: scripts/server/restore-check.sh
set -euo pipefail

DIR=${BACKUP_DIR:-/var/backups/vitalo}
UPLOADS=${UPLOADS_DIR:-/var/lib/vitalo/uploads}
ENV_FILE=${ENV_FILE:-/opt/vitalo/app/apps/api/.env}
DB_NAME=${DB_NAME:-vitalo}
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DIR"
umask 077

# Through the local socket as the vitalo role: no password needed or stored.
DUMP="$DIR/db-$STAMP.dump"
pg_dump --dbname="$DB_NAME" --format=custom --file="$DUMP.part"
if ! pg_restore --list "$DUMP.part" >/dev/null; then
  rm -f "$DUMP.part"
  echo "ОШИБКА: копия базы не читается, файл удалён. Старые копии не тронуты." >&2
  exit 1
fi
mv "$DUMP.part" "$DUMP"
echo "База: $DUMP ($(du -h "$DUMP" | cut -f1)), проверена"

if [ "${1:-all}" != "db" ]; then
  if [ -d "$UPLOADS" ]; then
    tar -czf "$DIR/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
    echo "Фото: $DIR/uploads-$STAMP.tar.gz ($(du -h "$DIR/uploads-$STAMP.tar.gz" | cut -f1))"
  fi
  # The settings file holds secrets: the copy stays in this closed folder with the same rights (600).
  if [ -r "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$DIR/env-$STAMP.env"
    chmod 600 "$DIR/env-$STAMP.env"
    echo "Настройки (.env): $DIR/env-$STAMP.env — внутри секреты, никому не пересылать"
  fi
fi

find "$DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' -o -name 'env-*.env' \) -mtime +"$KEEP_DAYS" -delete
find "$DIR" -maxdepth 1 -type f -name '*.part' -mmin +120 -delete
