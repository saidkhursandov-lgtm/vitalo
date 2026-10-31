#!/usr/bin/env bash
# Kept for the installed timer (vitalo-backup.service) and update.sh: the backup itself is scripts/server/backup.sh.
#   backup.sh       -> database + product photos + payment receipts + a copy of .env
#   backup.sh db    -> database only
exec "$(dirname "$(readlink -f "$0")")/../../scripts/server/backup.sh" "$@"
