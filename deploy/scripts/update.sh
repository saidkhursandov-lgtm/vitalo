#!/usr/bin/env bash
# Puts the latest pushed code live. Run on the server as the `vitalo` user:
#   /opt/vitalo/app/deploy/scripts/update.sh            -> update; STOPS if there are new database migrations
#   /opt/vitalo/app/deploy/scripts/update.sh --migrate  -> update and apply the new migrations (after a backup)
#   /opt/vitalo/app/deploy/scripts/update.sh --check    -> only show what would happen; changes nothing
#
# Database migrations are never applied by default (Stage 0.4): the script backs up the database, lists the
# migrations of the new code that the database does not have yet and stops before touching the code, so the
# shop keeps running the old version. Applying them needs --migrate, or typing "yes" when asked in a terminal.
# Steps: new code from /opt/vitalo/repo.git -> backup -> migrations check -> dependencies -> [migrations]
# -> build -> restart -> check. The live site keeps working during the build.
set -euo pipefail

APP=${APP:-/opt/vitalo/app}
BRANCH=${BRANCH:-main}
DB_NAME=${DB_NAME:-vitalo}
MIGRATIONS_DIR=apps/api/prisma/migrations

MODE=update
for arg in "$@"; do
  case "$arg" in
    --migrate) MODE=migrate ;;
    --check) MODE=check ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Неизвестный параметр: $arg (есть --check и --migrate)" >&2
      exit 2
      ;;
  esac
done

cd "$APP"

if [ "$MODE" != "check" ] && [ "$(id -un)" != "vitalo" ]; then
  echo "Запустите от пользователя vitalo:  sudo -iu vitalo $0 $*" >&2
  exit 1
fi

# Migration folders in the new code (origin/BRANCH) that are not finished in the database yet.
pending_migrations() {
  local all applied exists
  all=$(git ls-tree --name-only "origin/$BRANCH" "$MIGRATIONS_DIR/" | sed "s#^$MIGRATIONS_DIR/##" | grep -v '\.toml$' | sort)
  # Read-only queries through the local socket as the vitalo role (no password).
  if ! exists=$(psql -X -At -d "$DB_NAME" -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null); then
    echo "!cannot-read"
    return 0
  fi
  applied=""
  if [ "$exists" = "t" ]; then
    if ! applied=$(psql -X -At -d "$DB_NAME" -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1" 2>/dev/null); then
      echo "!cannot-read"
      return 0
    fi
  fi
  comm -23 <(printf '%s\n' "$all") <(printf '%s\n' "$applied" | sort) | sed '/^$/d'
}

echo "1/9 Новый код из /opt/vitalo/repo.git (ветка $BRANCH)"
git fetch --quiet origin "$BRANCH"
echo "    сейчас работает: $(git log -1 --format='%h %s (%cr)' HEAD)"
echo "    придёт:          $(git log -1 --format='%h %s (%cr)' "origin/$BRANCH")"
NEW_COMMITS=$(git log --oneline "HEAD..origin/$BRANCH" | wc -l | tr -d ' ')
echo "    новых коммитов: $NEW_COMMITS"

PENDING=$(pending_migrations)
if [ "$PENDING" = "!cannot-read" ]; then
  echo "    Не удалось прочитать список применённых миграций из базы $DB_NAME (psql). Остановлено, ничего не изменено." >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then
  echo
  echo "Режим --check: ничего не меняется (git fetch только скачал новый код в хранилище, рабочая папка не тронута)."
  if [ -n "$PENDING" ]; then
    echo "Новые миграции базы ($DB_NAME), их нет в базе:"
    printf '    %s\n' $PENDING
    echo "Обычный запуск остановится на них. Применить: $0 --migrate"
  else
    echo "Новых миграций нет: обычный запуск обновит код, соберёт и перезапустит службы."
  fi
  echo "Шаги обычного запуска: копия базы -> замена кода -> зависимости -> сборка API, магазина и админки -> перезапуск vitalo-api и vitalo-bot -> проверка."
  exit 0
fi

echo "2/9 Резервная копия базы перед изменениями"
"$APP/deploy/scripts/backup.sh" db

echo "3/9 Миграции базы"
if [ -z "$PENDING" ]; then
  echo "    новых миграций нет"
else
  echo "    Новые миграции, которых нет в базе $DB_NAME:"
  printf '      %s\n' $PENDING
  if [ "$MODE" != "migrate" ]; then
    if [ -t 0 ]; then
      read -r -p "    Применить эти миграции к рабочей базе? Напишите yes и Enter (иначе — остановка): " ANSWER
      [ "$ANSWER" = "yes" ] && MODE=migrate
    fi
  fi
  if [ "$MODE" != "migrate" ]; then
    echo
    echo "    ОСТАНОВЛЕНО: миграции не применены, код и службы не менялись — магазин работает как раньше."
    echo "    Копия базы уже сделана (папка /var/backups/vitalo)."
    echo "    Когда будете готовы применить миграции и обновить магазин:"
    echo "      sudo -iu vitalo $0 --migrate"
    exit 3
  fi
  echo "    будут применены после установки зависимостей (--migrate)"
fi

echo "4/9 Замена кода"
git reset --quiet --hard "origin/$BRANCH"
git log -1 --format='    %h %s (%cr)'

echo "5/9 Зависимости"
for a in api miniapp admin bot; do
  (cd "apps/$a" && npm ci --include=dev --no-audit --no-fund --loglevel=error)
done

echo "6/9 Prisma-клиент$([ -n "$PENDING" ] && echo ' и миграции')"
(
  cd apps/api
  npx prisma generate >/dev/null
  if [ -n "$PENDING" ]; then
    npx prisma migrate status || true
    npx prisma migrate deploy
  fi
)

echo "7/9 Сборка API"
(cd apps/api && npm run build --silent)

echo "8/9 Сборка магазина и админки (в отдельную папку, затем быстрая замена)"
for a in miniapp admin; do
  (
    cd "apps/$a"
    npm run typecheck --silent
    NODE_ENV=production npx vite build --outDir dist-next --emptyOutDir --logLevel warn
    rm -rf dist-prev
    if [ -d dist ]; then mv dist dist-prev; fi
    mv dist-next dist
    rm -rf dist-prev
  )
done

echo "9/9 Перезапуск служб и проверка"
sudo /usr/bin/systemctl restart vitalo-api vitalo-bot
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/api/catalog/texts; then
    echo "    API отвечает. Готово."
    exit 0
  fi
  sleep 1
done
echo "    API не ответил за 20 секунд. Смотрите: journalctl -u vitalo-api -n 50" >&2
exit 1
