#!/usr/bin/env bash
# Backup of the shop. Run as the `vitalo` user (the timer vitalo-backup.timer does it every night at 03:30).
#   backup.sh       -> database + product photos + payment receipts (3.1) + review photos on moderation (3.10-Б) + a copy of the settings file (.env)
#   backup.sh db    -> database only (update.sh does this before every update)
# Files: /var/backups/vitalo (only the vitalo user can read it), kept KEEP_DAYS days (14 by default).
# Every database copy is checked right away (pg_restore can read its table of contents), otherwise the script fails.
# Copy the files off the server regularly: docs/DEPLOY_RUNBOOK.md, phase 7.
# Restore check on a temporary database: scripts/server/restore-check.sh
set -euo pipefail

DIR=${BACKUP_DIR:-/var/backups/vitalo}
UPLOADS=${UPLOADS_DIR:-/var/lib/vitalo/uploads}
# 3.1: receipts customers send to the bot (card transfers). Private: nginx does not serve this folder.
RECEIPTS=${RECEIPTS_DIR:-/var/lib/vitalo/receipts}
# 3.10-Б: photos of reviews not yet published (private too; published copies are in the uploads folder).
REVIEWS=${REVIEWS_DIR:-/var/lib/vitalo/reviews}
# 3.10-В: photos of return requests (private, never public).
RETURNS=${RETURNS_DIR:-/var/lib/vitalo/returns}
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
  if [ -d "$RECEIPTS" ]; then
    tar -czf "$DIR/receipts-$STAMP.tar.gz" -C "$(dirname "$RECEIPTS")" "$(basename "$RECEIPTS")"
    echo "Чеки: $DIR/receipts-$STAMP.tar.gz ($(du -h "$DIR/receipts-$STAMP.tar.gz" | cut -f1))"
  fi
  if [ -d "$REVIEWS" ]; then
    tar -czf "$DIR/reviews-$STAMP.tar.gz" -C "$(dirname "$REVIEWS")" "$(basename "$REVIEWS")"
    echo "Фото отзывов: $DIR/reviews-$STAMP.tar.gz ($(du -h "$DIR/reviews-$STAMP.tar.gz" | cut -f1))"
  fi
  if [ -d "$RETURNS" ]; then
    tar -czf "$DIR/returns-$STAMP.tar.gz" -C "$(dirname "$RETURNS")" "$(basename "$RETURNS")"
    echo "Фото возвратов: $DIR/returns-$STAMP.tar.gz ($(du -h "$DIR/returns-$STAMP.tar.gz" | cut -f1))"
  fi
  # The settings file holds secrets: the copy stays in this closed folder with the same rights (600).
  if [ -r "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$DIR/env-$STAMP.env"
    chmod 600 "$DIR/env-$STAMP.env"
    echo "Настройки (.env): $DIR/env-$STAMP.env — внутри секреты, никому не пересылать"
  fi
fi

find "$DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' -o -name 'receipts-*.tar.gz' -o -name 'reviews-*.tar.gz' -o -name 'returns-*.tar.gz' -o -name 'env-*.env' \) -mtime +"$KEEP_DAYS" -delete
find "$DIR" -maxdepth 1 -type f -name '*.part' -mmin +120 -delete
