#!/usr/bin/env bash
# Twice-a-day report of the shop to the technical Telegram chat (17.11.2026, owner: «два раза в день»).
# Run by vitalo-monitor.timer at 09:00 and 21:00 (Tashkent) as the `vitalo` user; by hand:
#   sudo -iu vitalo /opt/vitalo/app/scripts/server/monitor.sh            -> checks and sends the report
#   sudo -iu vitalo /opt/vitalo/app/scripts/server/monitor.sh --dry-run  -> checks and prints, sends nothing
# Checks: everything of healthcheck.sh (API, database, Yandex poll, services, disk, backup on the server) plus the
# newest copy in Google Drive, the HTTPS certificate and the domain registration. Reads only.
# The message goes with the shop's bot (TELEGRAM_BOT_TOKEN) to TECH_CHAT_ID from the .env; the token is never printed.
# If the whole server is down this script cannot run: the GitHub workflow .github/workflows/uptime.yml covers that.
set -uo pipefail

APP=${APP:-/opt/vitalo/app}
ENV_FILE=${ENV_FILE:-$APP/apps/api/.env}
DOMAIN=${DOMAIN:-vitalo.uz}
GDRIVE_REMOTE=${GDRIVE_REMOTE:-gdrive:VITALO-backups}
CERT_WARN_DAYS=${CERT_WARN_DAYS:-20}
DOMAIN_WARN_DAYS=${DOMAIN_WARN_DAYS:-45}
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

BAD=()
INFO=()

# 1. The existing check (API, database, Yandex, services, disk, backup on the server).
HC=$("$APP/scripts/server/healthcheck.sh" 2>&1); HC_RC=$?
while IFS= read -r line; do
  case "$line" in "ПЛОХО"*) BAD+=("${line#ПЛОХО   }") ;; esac
done <<<"$HC"
FREE=$(printf '%s\n' "$HC" | grep -o 'свободно на диске: [0-9]* ГБ' | grep -o '[0-9]* ГБ')
[ -n "$FREE" ] && INFO+=("диск: свободно $FREE")
[ "$HC_RC" = "0" ] || [ "${#BAD[@]}" -gt 0 ] || BAD+=("healthcheck.sh завершился с ошибкой")

# 2. Google Drive: the newest vitalo-*.tar must be younger than 26 hours.
if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -qx 'gdrive:'; then
  LAST=$(rclone lsf --files-only --include 'vitalo-*.tar' "$GDRIVE_REMOTE" 2>/dev/null | sort | tail -n 1)
  if [ -z "$LAST" ]; then
    BAD+=("в Google Drive нет ни одной копии (папка ${GDRIVE_REMOTE#gdrive:})")
  else
    STAMP=${LAST#vitalo-}; STAMP=${STAMP%.tar}                       # 20261117-1711
    WHEN=$(date -d "${STAMP:0:8} ${STAMP:9:2}:${STAMP:11:2}" +%s 2>/dev/null || echo 0)
    AGE_H=$(( ($(date +%s) - WHEN) / 3600 ))
    if [ "$AGE_H" -le 26 ]; then INFO+=("копия в Google Drive: ${STAMP:6:2}.${STAMP:4:2} ${STAMP:9:2}:${STAMP:11:2}")
    else BAD+=("последняя копия в Google Drive старше суток ($LAST)"); fi
  fi
else
  BAD+=("Google Drive не подключён (scripts/server/gdrive-setup.sh)")
fi

# 3. HTTPS certificate (certbot renews it 30 days before the end; fewer than 20 days left means renewal fails).
END=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$END" ]; then
  DAYS=$(( ($(date -d "$END" +%s) - $(date +%s)) / 86400 ))
  if [ "$DAYS" -ge "$CERT_WARN_DAYS" ]; then INFO+=("сертификат HTTPS: ещё $DAYS дн.")
  else BAD+=("сертификат HTTPS кончается через $DAYS дн.: sudo certbot renew"); fi
else
  BAD+=("не удалось прочитать сертификат HTTPS")
fi

# 4. Domain registration (Hostmaster). A whois failure is only a note: the registry is sometimes slow.
EXP=$(timeout 20 whois "$DOMAIN" 2>/dev/null | grep -i 'Expiration Date' | head -n 1 | sed 's/.*: *//')
if [ -n "$EXP" ]; then
  DDAYS=$(( ($(date -d "$EXP" +%s) - $(date +%s)) / 86400 ))
  if [ "$DDAYS" -ge "$DOMAIN_WARN_DAYS" ]; then INFO+=("домен $DOMAIN оплачен до $(date -d "$EXP" +%d.%m.%Y)")
  else BAD+=("домен $DOMAIN кончается через $DDAYS дн. ($(date -d "$EXP" +%d.%m.%Y)) — оплатить в Hostmaster"); fi
else
  INFO+=("домен: whois не ответил, проверю в следующий раз")
fi

NOW=$(date +%H:%M)
if [ "${#BAD[@]}" -eq 0 ]; then
  TEXT="VITALO, проверка $NOW: всё работает."$'\n'"$(printf '— %s\n' "${INFO[@]}")"
else
  TEXT="VITALO, проверка $NOW: ЕСТЬ ПРОБЛЕМЫ"$'\n'"$(printf '! %s\n' "${BAD[@]}")"$'\n\n'"$(printf '— %s\n' "${INFO[@]}")"
fi

if [ "$DRY" = "1" ]; then printf '%s\n' "$TEXT"; exit 0; fi

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT=$(grep -E '^TECH_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  printf '%s\n' "$TEXT"; echo "Не отправлено: в $ENV_FILE пусто TELEGRAM_BOT_TOKEN или TECH_CHAT_ID" >&2; exit 1
fi
# The token goes to curl through stdin (-K -), so it is not visible in the list of processes.
if printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" |
   curl -sS -m 20 -K - --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$TEXT" -o /dev/null -w '%{http_code}' | grep -qx 200; then
  echo "Отчёт отправлен в технический чат."
else
  printf '%s\n' "$TEXT"; echo "Telegram не принял сообщение" >&2; exit 1
fi
