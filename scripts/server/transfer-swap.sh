#!/usr/bin/env bash
# The move, step 2 of 2 (docs/DEPLOY_RUNBOOK.md, phase 3): the restored `vitalo_new` becomes the working database.
# Run on the server through sudo, after transfer-restore.sh:
#   sudo /opt/vitalo/app/scripts/server/transfer-swap.sh
# What it does: stops the API and the bot -> one more backup of the current database -> renames
#   vitalo      -> vitalo_before_transfer_<date>   (kept: this is the way back)
#   vitalo_new  -> vitalo
# Nothing is deleted. The services stay STOPPED: first run `npm run server:after-transfer`, then start them
# (the runbook says how). The way back is printed at the end.
set -euo pipefail
cd / # sudo -u vitalo / postgres must be able to enter the current folder

NEW_DB=vitalo_new
DB_NAME=vitalo
OLD_DB="vitalo_before_transfer_$(date +%Y%m%d_%H%M)"
APP=${APP:-/opt/vitalo/app}

if [ "$(id -u)" != "0" ]; then
  echo "Запустите через sudo:  sudo $0 $*" >&2
  exit 1
fi
exists() { [ "$(sudo -u postgres psql -X -At -c "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]; }
exists "$NEW_DB" || { echo "Нет базы $NEW_DB: сначала transfer-restore.sh" >&2; exit 1; }
exists "$DB_NAME" || { echo "Нет рабочей базы $DB_NAME — остановлено." >&2; exit 1; }

echo "Сейчас рабочая база магазина будет ЗАМЕНЕНА той, что восстановлена в $NEW_DB."
echo "Всё, что есть только в нынешней серверной базе (заказы, покупатели, настройки, сотрудники), останется"
echo "в базе $OLD_DB и в резервной копии, но в магазине видно не будет."
read -r -p "Чтобы продолжить, напишите слово REPLACE (латинскими буквами) и нажмите Enter: " ANSWER
[ "$ANSWER" = "REPLACE" ] || { echo "Отменено, ничего не изменено."; exit 1; }

echo "1/4 Остановка магазина (API и бот)"
sudo systemctl stop vitalo-bot vitalo-api

restart_old() {
  echo "Не получилось — магазин запускается на прежней базе." >&2
  sudo systemctl start vitalo-api vitalo-bot || true
}
trap restart_old ERR

echo "2/4 Резервная копия нынешней базы"
sudo -u vitalo "$APP/scripts/server/backup.sh" db

echo "3/4 Проверка, что к базам никто не подключён"
sudo -u postgres psql -X -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB_NAME','$NEW_DB') AND pid <> pg_backend_pid()" >/dev/null

echo "4/4 Переименование"
sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 <<SQL
ALTER DATABASE "$DB_NAME" RENAME TO "$OLD_DB";
ALTER DATABASE "$NEW_DB" RENAME TO "$DB_NAME";
SQL
trap - ERR

echo
echo "ГОТОВО: рабочая база теперь — восстановленная копия. Прежняя база сохранена под именем $OLD_DB."
echo "Службы ОСТАНОВЛЕНЫ. При переезде — дальше по инструкции (фаза 3): server:after-transfer, затем запуск служб."
echo "При восстановлении из ночной копии (фаза 7.4): sudo systemctl start vitalo-api vitalo-bot"
echo
echo "КАК ВЕРНУТЬ ВСЁ НАЗАД (если что-то пошло не так):"
echo "  sudo systemctl stop vitalo-bot vitalo-api"
echo "  sudo -u postgres psql -c 'ALTER DATABASE \"$DB_NAME\" RENAME TO \"vitalo_failed_transfer\"'"
echo "  sudo -u postgres psql -c 'ALTER DATABASE \"$OLD_DB\" RENAME TO \"$DB_NAME\"'"
echo "  sudo systemctl start vitalo-api vitalo-bot"
