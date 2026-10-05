#!/usr/bin/env bash
# Puts the latest pushed code live. Run on the server as the `vitalo` user:
#   /opt/vitalo/app/deploy/scripts/update.sh
# Steps: take the code pushed to /opt/vitalo/repo.git -> backup of the database -> dependencies ->
# migrations (only additive ones are written in this project) -> build -> restart -> check.
# The live site keeps working during the build: the new shop/admin files replace the old ones at the end.
set -euo pipefail

APP=/opt/vitalo/app
BRANCH=${BRANCH:-main}
cd "$APP"

if [ "$(id -un)" != "vitalo" ]; then
  echo "Запустите от пользователя vitalo:  sudo -iu vitalo $0" >&2
  exit 1
fi

echo "1/8 Код из /opt/vitalo/repo.git (ветка $BRANCH)"
git fetch --quiet origin "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
git log -1 --format='    %h %s (%cr)'

echo "2/8 Резервная копия базы перед изменениями"
"$APP/deploy/scripts/backup.sh" db

echo "3/8 Зависимости"
for a in api miniapp admin bot; do
  (cd "apps/$a" && npm ci --include=dev --no-audit --no-fund --loglevel=error)
done

echo "4/8 Миграции базы"
(cd apps/api && npx prisma generate >/dev/null && npx prisma migrate deploy)

echo "5/8 Сборка API"
(cd apps/api && npm run build --silent)

echo "6/8 Сборка магазина и админки (в отдельную папку, затем быстрая замена)"
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

echo "7/8 Перезапуск служб"
sudo /usr/bin/systemctl restart vitalo-api vitalo-bot

echo "8/8 Проверка"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/api/catalog/texts; then
    echo "    API отвечает. Готово."
    exit 0
  fi
  sleep 1
done
echo "    API не ответил за 20 секунд. Смотрите: journalctl -u vitalo-api -n 50" >&2
exit 1
