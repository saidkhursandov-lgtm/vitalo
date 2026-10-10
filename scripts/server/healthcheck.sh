#!/usr/bin/env bash
# Is the shop alive? Reads only. Run on the server (sudo: the folders of the shop are closed for other users):
#   sudo /opt/vitalo/app/scripts/server/healthcheck.sh
#   sudo /opt/vitalo/app/scripts/server/healthcheck.sh --max-sync-minutes 30 --min-free-gb 3
#   bash healthcheck.sh --url https://api.vitalo.uz/api/health   (from anywhere)
# Checks: the API answers, the database answers, the last Yandex poll is not older than N minutes (only when the
# poll is switched on), free disk space, the newest backup is younger than 26 hours.
# Exit code 0 = everything is fine, 1 = something is wrong (the lines with «ПЛОХО» say what).
# An external monitor (UptimeRobot etc.) needs only the address https://api.vitalo.uz/api/health: 200 = fine.
set -uo pipefail

URL=http://127.0.0.1:3000/api/health
MAX_SYNC=""
MIN_FREE_GB=2
BACKUP_DIR=${BACKUP_DIR:-/var/backups/vitalo}
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL=$2; shift 2 ;;
    --max-sync-minutes) MAX_SYNC=$2; shift 2 ;;
    --min-free-gb) MIN_FREE_GB=$2; shift 2 ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

FAIL=0
ok() { echo "ХОРОШО  $1"; }
bad() { echo "ПЛОХО   $1"; FAIL=1; }
note() { echo "        $1"; }

BODY=$(curl -sS -m 10 "$URL" 2>/dev/null) || BODY=""
field() { # top-level or yandex_sync field of the health answer; empty when absent
  printf '%s' "$BODY" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s); const v = process.argv[1].split(".").reduce((o, k) => (o == null ? o : o[k]), j); process.stdout.write(v == null ? "" : String(v)); } catch { /* not JSON */ }
    });' "$1" 2>/dev/null
}

if [ -z "$BODY" ]; then
  bad "API не отвечает ($URL). Смотрите: journalctl -u vitalo-api -n 50 --no-pager"
else
  STATUS=$(field status)
  if [ "$(field db)" = "true" ]; then ok "API отвечает, база данных отвечает"; else bad "API отвечает, но база данных — нет"; fi
  if [ "$(field yandex_sync.enabled)" = "true" ]; then
    MINUTES=$(field yandex_sync.minutes_since_last)
    LIMIT=${MAX_SYNC:-$(field yandex_sync.max_minutes)}
    if [ -z "$MINUTES" ]; then
      if [ "$(field yandex_sync.stale)" = "true" ]; then bad "Яндекс: опрос включён, но ещё ни разу не прошёл успешно"; else note "Яндекс: опрос включён, первый запуск ещё не прошёл"; fi
    elif [ "$MINUTES" -gt "$LIMIT" ]; then
      bad "Яндекс: последняя успешная синхронизация $MINUTES мин назад (допустимо до $LIMIT)"
    else
      ok "Яндекс: последняя успешная синхронизация $MINUTES мин назад (допустимо до $LIMIT)"
    fi
  else
    note "Яндекс: опрос выключен (YANDEX_SYNC_ENABLED) — не проверяется"
  fi
  [ "$STATUS" = "ok" ] || [ "$FAIL" = "1" ] || bad "API сообщает состояние «$STATUS»"
fi

# The rest makes sense only on the server itself.
if [ "${URL#http://127.0.0.1}" != "$URL" ]; then
  for s in vitalo-api vitalo-bot nginx postgresql; do
    if systemctl is-active --quiet "$s"; then ok "служба $s работает"; else bad "служба $s не работает: systemctl status $s"; fi
  done

  FREE_GB=$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')
  if [ "${FREE_GB:-0}" -ge "$MIN_FREE_GB" ]; then ok "свободно на диске: ${FREE_GB} ГБ"; else bad "мало места на диске: ${FREE_GB:-?} ГБ (нужно от $MIN_FREE_GB)"; fi

  if [ -r "$BACKUP_DIR" ]; then
    if [ -n "$(find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.dump' -mmin -1560 2>/dev/null | head -n 1)" ]; then
      ok "есть копия базы моложе 26 часов"
    else
      bad "нет копии базы моложе 26 часов: systemctl list-timers vitalo-backup.timer"
    fi
  else
    note "копии базы: папка $BACKUP_DIR доступна только пользователю vitalo (запустите через sudo, чтобы проверить)"
  fi
fi

if [ "$FAIL" = "0" ]; then echo "ИТОГ: всё в порядке"; else echo "ИТОГ: есть проблемы (строки «ПЛОХО»)"; fi
exit "$FAIL"
