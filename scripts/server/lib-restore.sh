#!/usr/bin/env bash
# Shared by transfer-restore.sh and restore-check.sh (not run on its own): restores a copy of the database into an
# EMPTY database that belongs to the `vitalo` role. Everything is done as `vitalo` — an ordinary role, NOT a
# superuser, exactly like the shop itself — so what is restored is owned by the role the API connects as.
#
#   restore_into <database> <dump>      returns 0 only when every step went through without a single error
#
# Why it works without a superuser (S-E-11):
#   --no-owner / --no-acl  no ALTER … OWNER and no GRANT from the copy: every object simply belongs to vitalo;
#   --no-comments          no COMMENT ON EXTENSION (allowed only to the owner of the extension);
#   extensions             pg_trgm and unaccent are «trusted»: the owner of the database may create them. They are
#                          created BEFORE the restore, so CREATE EXTENSION IF NOT EXISTS in the copy does nothing;
#   three passes           structure -> qualify-search-functions.sql -> data -> indexes, constraints, triggers:
#                          the small fix must be in place before the search index of products is rebuilt.
# Any error of pg_restore stops the restore (--exit-on-error): a half-restored database is never accepted.

RESTORE_FLAGS=(--no-owner --no-acl --no-comments --exit-on-error)
RESTORE_LIB_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

restore_into() {
  local db=$1 dump=$2 ext
  for ext in pg_trgm unaccent; do
    if ! sudo -u vitalo psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "CREATE EXTENSION IF NOT EXISTS $ext" 2>/dev/null; then
      # only if this server does not let the owner of a database create it
      sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "CREATE EXTENSION IF NOT EXISTS $ext" || return 1
    fi
  done
  echo "    структура…"
  sudo -u vitalo pg_restore "${RESTORE_FLAGS[@]}" --section=pre-data -d "$db" "$dump" || return 1
  sudo -u vitalo psql -X -q -v ON_ERROR_STOP=1 -d "$db" <"$RESTORE_LIB_DIR/qualify-search-functions.sql" || return 1
  echo "    данные…"
  sudo -u vitalo pg_restore "${RESTORE_FLAGS[@]}" --section=data -d "$db" "$dump" || return 1
  echo "    индексы, проверки и защиты (триггеры)…"
  sudo -u vitalo pg_restore "${RESTORE_FLAGS[@]}" --section=post-data -d "$db" "$dump" || return 1
}
