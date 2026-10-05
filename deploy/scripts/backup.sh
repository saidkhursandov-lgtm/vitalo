#!/usr/bin/env bash
# Backup of the shop. Run as the `vitalo` user (the timer vitalo-backup.timer does it every night).
#   backup.sh       -> database + product photos
#   backup.sh db    -> database only (update.sh does this before every update)
# Files: /var/backups/vitalo, kept KEEP_DAYS days (14 by default). Copy them off the server regularly too.
# Restore the database:  pg_restore --clean --if-exists --no-owner -d vitalo /var/backups/vitalo/db-YYYYMMDD-HHMM.dump
set -euo pipefail

DIR=/var/backups/vitalo
UPLOADS=/var/lib/vitalo/uploads
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DIR"
umask 077

# Through the local socket as the vitalo role: no password needed or stored.
pg_dump --dbname=vitalo --format=custom --file="$DIR/db-$STAMP.dump"
echo "База: $DIR/db-$STAMP.dump ($(du -h "$DIR/db-$STAMP.dump" | cut -f1))"

if [ "${1:-all}" != "db" ] && [ -d "$UPLOADS" ]; then
  tar -czf "$DIR/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
  echo "Фото: $DIR/uploads-$STAMP.tar.gz ($(du -h "$DIR/uploads-$STAMP.tar.gz" | cut -f1))"
fi

find "$DIR" -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
