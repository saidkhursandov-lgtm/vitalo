#!/usr/bin/env bash
# Checks of the server BEFORE the move (docs/DEPLOY_RUNBOOK.md, phase 0). Reads only, changes nothing.
# Run through sudo (it reads the firewall, the SSH settings and the rights of the settings file):
#   sudo /opt/vitalo/app/scripts/server/preflight.sh
# Every line starts with ХОРОШО, ВНИМАНИЕ or ПЛОХО. Exit code 1 when there is at least one ПЛОХО.
# No secret is printed: for the settings file only the NAMES of the filled keys are shown.
set -uo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "Запустите через sudo:  sudo $0" >&2
  exit 1
fi

APP=${APP:-/opt/vitalo/app}
ENV_FILE="$APP/apps/api/.env"
FAIL=0
ok() { echo "ХОРОШО    $1"; }
warn() { echo "ВНИМАНИЕ  $1"; }
bad() { echo "ПЛОХО     $1"; FAIL=1; }
head1() { echo; echo "== $1"; }

head1 "Система"
. /etc/os-release 2>/dev/null || true
echo "          ${PRETTY_NAME:-неизвестная ОС}, ядро $(uname -r)"
[ "${VERSION_ID:-}" = "24.04" ] && ok "Ubuntu 24.04" || warn "ожидалась Ubuntu 24.04, здесь ${VERSION_ID:-?}"
TZ_NOW=$(timedatectl show -p Timezone --value 2>/dev/null || echo "?")
[ "$TZ_NOW" = "Asia/Tashkent" ] && ok "часовой пояс Asia/Tashkent" || warn "часовой пояс $TZ_NOW (нужен Asia/Tashkent: напоминания и бэкап идут по времени сервера)"
MEM_MB=$(free -m | awk '/^Mem:/ {print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/ {print $2}')
echo "          память ${MEM_MB} МБ, подкачка ${SWAP_MB} МБ, процессоров $(nproc)"
[ "$((MEM_MB + SWAP_MB))" -ge 3500 ] && ok "памяти хватит для сборки" || warn "памяти с подкачкой меньше 3.5 ГБ: сборка может не поместиться (DEPLOY.md, раздел 2.1)"
FREE_GB=$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')
[ "${FREE_GB:-0}" -ge 5 ] && ok "свободно на диске ${FREE_GB} ГБ" || bad "свободно на диске ${FREE_GB:-?} ГБ, нужно не меньше 5"

head1 "Программы"
ver() { command -v "$1" >/dev/null 2>&1 && "$@" 2>&1 | head -n 1 || echo "нет"; }
NODE_V=$(ver node -v)
echo "          node $NODE_V, npm $(ver npm -v), $(ver psql --version), $(nginx -v 2>&1 | head -n 1), git $(git --version 2>/dev/null | awk '{print $3}')"
case "$NODE_V" in v2[2-9].* | v[3-9][0-9].*) ok "Node.js подходит" ;; *) bad "нужен Node.js 22 или новее (DEPLOY.md, раздел 3)" ;; esac
psql --version 2>/dev/null | grep -q ' 16\.' && ok "PostgreSQL 16 (как на компьютере: копия базы подойдёт)" || bad "нужен PostgreSQL 16: копия базы делается версией 16"
command -v certbot >/dev/null 2>&1 && ok "certbot установлен" || bad "certbot не установлен"

head1 "Брандмауэр и сеть"
UFW=$(sudo ufw status 2>/dev/null)
if echo "$UFW" | grep -q "Status: active"; then
  ok "ufw включён"
  OPEN=$(echo "$UFW" | awk '/ALLOW/ {print $1}' | sed 's#/tcp##' | sort -u | tr '\n' ' ')
  echo "          открыто наружу: $OPEN"
  EXTRA=$(echo "$UFW" | awk '/ALLOW/ {print $1}' | sed 's#/tcp##' | grep -Ev '^(22|80|443|OpenSSH)$' | sort -u | tr '\n' ' ')
  [ -z "$EXTRA" ] && ok "наружу открыты только 22, 80, 443" || bad "лишние открытые порты: $EXTRA"
else
  bad "ufw выключен: sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable"
fi
LISTEN=$(sudo ss -ltnH 2>/dev/null | awk '{print $4}')
local_only() { # port, name
  local lines
  lines=$(echo "$LISTEN" | grep -E "[:.]$1\$" || true)
  if [ -z "$lines" ]; then
    echo "          $2 (порт $1): не слушает"
  elif echo "$lines" | grep -Evq '^(127\.0\.0\.1|\[::1\]|localhost):'; then
    bad "$2 (порт $1) слушает не только этот сервер: $(echo "$lines" | tr '\n' ' ')"
  else
    ok "$2 (порт $1) доступен только с самого сервера"
  fi
}
local_only 5432 "PostgreSQL"
local_only 6379 "Redis"
local_only 3000 "API"

head1 "Вход по SSH"
SSHD=$(sudo sshd -T 2>/dev/null)
echo "$SSHD" | grep -qi '^passwordauthentication no' && ok "вход по паролю выключен (только по ключу)" || bad "вход по паролю включён (DEPLOY.md, раздел 2.2)"
echo "$SSHD" | grep -qi '^permitrootlogin no' && ok "вход под root выключен" || warn "вход под root не выключен"
systemctl is-active --quiet fail2ban && ok "fail2ban работает" || bad "fail2ban не работает: sudo apt -y install fail2ban && sudo systemctl enable --now fail2ban"
systemctl is-enabled --quiet unattended-upgrades 2>/dev/null && ok "автообновления безопасности включены" || warn "автообновления безопасности не включены (DEPLOY.md, раздел 2.1)"

head1 "Магазин"
[ -d "$APP/.git" ] && echo "          код: $(sudo -u vitalo git -C "$APP" log -1 --format='%h %s (%cr)' 2>/dev/null)" || bad "нет папки с кодом $APP"
for s in vitalo-api vitalo-bot nginx postgresql; do
  systemctl is-active --quiet "$s" && ok "служба $s работает" || warn "служба $s не работает"
done
systemctl is-active --quiet vitalo-backup.timer && ok "ночной бэкап включён" || bad "ночной бэкап не включён: sudo systemctl enable --now vitalo-backup.timer"
if sudo test -f "$ENV_FILE"; then
  PERM=$(sudo stat -c '%a %U' "$ENV_FILE")
  [ "$PERM" = "600 vitalo" ] && ok "файл настроек закрыт (600, владелец vitalo)" || bad "файл настроек: права «$PERM», нужно «600 vitalo»"
  FILLED=$(sudo grep -E '^[A-Z_]+=.+' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ')
  echo "          заполнены (только имена): $FILLED"
  for k in TELEGRAM_BOT_TOKEN BOT_API_SECRET DATABASE_URL MINIAPP_URL ADMIN_URL; do
    echo " $FILLED " | grep -q " $k " || bad "в файле настроек пусто: $k"
  done
  sudo grep -q '^NODE_ENV=production' "$ENV_FILE" && ok "NODE_ENV=production" || bad "в файле настроек нет NODE_ENV=production"
else
  bad "нет файла настроек $ENV_FILE"
fi
if sudo test -d /var/backups/vitalo; then
  LAST=$(sudo bash -c 'ls -1t /var/backups/vitalo/db-*.dump 2>/dev/null | head -n 1')
  [ -n "$LAST" ] && echo "          последняя копия базы: $LAST" || warn "копий базы пока нет"
fi

head1 "Сертификат HTTPS"
CERT=/etc/letsencrypt/live/vitalo.uz/fullchain.pem
if sudo test -f "$CERT"; then
  END=$(sudo openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)
  DAYS=$((($(date -d "$END" +%s) - $(date +%s)) / 86400))
  [ "$DAYS" -ge 15 ] && ok "сертификат действует ещё $DAYS дн." || bad "сертификат истекает через $DAYS дн.: sudo certbot renew"
  NAMES=$(sudo openssl x509 -noout -ext subjectAltName -in "$CERT" 2>/dev/null | tr -d ' \n')
  for d in vitalo.uz admin.vitalo.uz api.vitalo.uz; do
    echo "$NAMES" | grep -q "DNS:$d" && ok "сертификат включает $d" || bad "в сертификате нет $d"
  done
  systemctl is-active --quiet certbot.timer && ok "автопродление сертификата включено" || warn "таймер certbot не работает: systemctl list-timers | grep certbot"
else
  bad "сертификата нет (DEPLOY.md, раздел 9)"
fi

echo
if [ "$FAIL" = "0" ]; then echo "ИТОГ: можно продолжать (строки «ВНИМАНИЕ» прочитайте)"; else echo "ИТОГ: сначала исправьте строки «ПЛОХО»"; fi
exit "$FAIL"
