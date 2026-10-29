# Перенос VITALO на другой ноутбук (Windows)

Здесь нет паролей и ключей. Секретные файлы переносятся вручную на флешке (список ниже).

## Версии на старом ноутбуке (29.10.2026)

| Программа | Версия | Где взять |
| --- | --- | --- |
| Node.js | 24.21.0 | nodejs.org, ветка 24 LTS |
| npm | 11.19.0 | ставится вместе с Node.js |
| Git | 2.55.0 (Git for Windows) | git-scm.com |
| Docker Desktop | Docker 29.8.1, Compose 5.5.1 | docker.com |
| PostgreSQL | 16.15 — в Docker (образ `postgres:16`), отдельно ставить не нужно | — |
| Redis | 7 — в Docker (образ `redis:7`) | — |
| cloudflared (по желанию, туннель для телефона) | 2026.9.3 | `winget install --id Cloudflare.cloudflared` |

## Что перенести на флешке (в git этого нет)

| Что | Где лежит на старом ноутбуке | Куда положить на новом |
| --- | --- | --- |
| **Главный файл с секретами** (токен бота, ключи Яндекса и оплат) | `apps\api\.env` | туда же, `apps\api\.env` |
| **SSH-ключ для сервера** (оба файла) | `C:\Users\<пользователь>\.ssh\id_ed25519` и `id_ed25519.pub` | `C:\Users\<новый пользователь>\.ssh\` |
| Копия базы для нового ноутбука | `backups\vitalo_dev-for-new-laptop-20261029.dump` | `backups\` |
| Старые копии базы (по желанию) | `backups\`, `apps\api\backups\`, `backup_vitalo_dev_before_catalog.sql` | те же папки |
| Таблицы с товарами и ценами | `VITALO_*.xlsx` в корне проекта (4 файла) | корень проекта |
| Фото товаров (исходники) | `photos\` | `photos\` |
| Загруженные файлы локального магазина | `apps\api\uploads\` | `apps\api\uploads\` |
| Старая копия `.env` (по желанию) | `apps\api\.env.bak-20261006-2233` | `apps\api\` |

Папку `.runtime\` переносить не нужно — она создаётся заново при запуске.
Флешку с этими файлами храните как ключи от магазина: после переноса лучше стереть с неё `.env` и SSH-ключ.

## Шаги на новом ноутбуке

1. Установить Git, Node.js 24, Docker Desktop (и при желании cloudflared). Запустить Docker Desktop один раз.
2. Скачать код (в PowerShell):

   ```powershell
   cd $HOME\Documents
   mkdir VITALO
   cd VITALO
   git clone https://github.com/saidkhursandov-lgtm/vitalo.git vitalo
   cd vitalo
   git checkout release-1
   ```

3. Скопировать файлы с флешки по таблице выше.
4. Поднять базу и загрузить в неё копию:

   ```powershell
   docker compose up -d postgres redis
   docker compose cp backups\vitalo_dev-for-new-laptop-20261029.dump postgres:/tmp/dev.dump
   docker compose exec -T postgres pg_restore -U vitalo -d vitalo_dev --no-owner /tmp/dev.dump
   ```

   Проверка — должно показать 34 товара и 17 заказов (как на старом ноутбуке 29.10.2026):

   ```powershell
   docker compose exec -T postgres psql -U vitalo -d vitalo_dev -c "select count(*) from products; select count(*) from orders;"
   ```

5. Запустить всё: двойной щелчок по `start.bat` (при первом запуске он сам выполнит `npm install` в каждой
   папке приложения). Остановить — `stop.bat`. Если окно API пишет ошибку про Prisma Client — один раз
   выполнить `cd apps\api` → `npx prisma generate` и снова `start.bat`.
6. Подключить сервер, чтобы и дальше выкладывать код (`git push server main`):

   ```powershell
   git remote add server vitalo@91.213.99.230:/opt/vitalo/repo.git
   ssh saidkomolkhursandov@91.213.99.230
   ```

   При первом входе SSH спросит пароль от ключа (тот, что вы вводите сейчас).

## Как запускается проект

| Что | Команда | Адрес |
| --- | --- | --- |
| Всё сразу | `start.bat` / `stop.bat` в корне | — |
| API | `cd apps\api` → `npm run start:dev` | http://localhost:3000/api/docs |
| Mini App | `cd apps\miniapp` → `npm run dev` | http://localhost:5173 |
| Админка | `cd apps\admin` → `npm run dev` | http://localhost:5174 |
| Бот | `cd apps\bot` → `npm run dev` | t.me/vitalo_store_bot |
| Туннель для телефона | `cd apps\bot` → `npm run tunnel` | адреса пишутся в окне туннеля |
| Автотесты | `cd apps\api` → `npm run test:e2e` | база `vitalo_test` создаётся сама |

Бот и туннель читают настройки из `apps\api\.env`.

## Важно

- Правила работы с базами — в [CLAUDE.md](CLAUDE.md): seed, миграции и скрипты на `vitalo_dev` — только с вашего
  разрешения, на сервере — только вы сами.
- В копии `vitalo_dev` от 29.10.2026 применены миграции до `20261014100000_stage3_finance`. Более новые
  (`20261015…`, `20261016…`, `20261017…`, `20261029…_release1_cash_on_delivery`) в неё ещё не применены —
  так же, как на старом ноутбуке.
- Ветка `release-1`: последний коммит — незаконченная «Оплата при получении». Ветка
  `fix/unit-tracking-purchase-receiving` — незаконченная работа S2B-10.
