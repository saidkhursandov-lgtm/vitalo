# VITALO — правила для Claude

Пользователь не программист: объясняй просто, по-русски, без жаргона.

## Что это

VITALO — интернет-магазин БАДов и витаминов в Узбекистане: Telegram-бот и Mini App для покупателей, админка для
сотрудников (заказы, склад, закупки, финансы, аналитика), синхронизация заказов с Яндекс Маркетом.
Языки: RU и UZ (латиница). Боевой магазин работает на сервере, разработка — на этом ноутбуке.

## С чего начинать

- Новая крупная задача: сначала [docs/PROGRESS.md](docs/PROGRESS.md) и нужный файл из `docs/` (карта ниже), а не весь код.
- **Журнал:** после каждой завершённой задачи вызывай субагента `progress-keeper` — он обновит `docs/PROGRESS.md`.
- Быстрая сводка для пользователя — команда `/status`.

## Папки и стек

| Папка | Что | Стек |
| --- | --- | --- |
| `apps/api` | API, фоновые задачи, уведомления | NestJS 11, Prisma 6, PostgreSQL 16, TypeScript |
| `apps/miniapp` | Mini App покупателя (порт 5173) | React 19, Vite 7, React Query |
| `apps/admin` | Админка (порт 5174) | React 19, Vite 7, React Query |
| `apps/bot` | Telegram-бот (long polling) и туннель | grammY, tsx |
| `deploy/`, `scripts/server/` | nginx, systemd, update.sh, бэкапы, проверки сервера | bash |
| `docs/` | документация и журнал | — |

Локально: Node.js 24.21.0, npm 11.19, Docker Desktop (postgres:16, redis:7), cloudflared 2026.10.5.
Проект на ноутбуке: `C:\Projects\vitalo`. Перенос на другой компьютер — [MIGRATION.md](MIGRATION.md).

## Команды

| Что | Команда |
| --- | --- |
| Запустить всё (Docker, API, Mini App, админка, бот, туннель) | `start.bat` (двойной щелчок) |
| Остановить всё | `stop.bat` |
| Тесты API (база `vitalo_test`, можно без разрешения) | `cd apps\api` → `npm test`, `npm run test:e2e` |
| Тесты Mini App / админки / бота | `npm test` в папке приложения |
| Prisma Client после смены схемы | `cd apps\api` → `npx prisma generate`, затем перезапустить API (`stop.bat` → `start.bat`): `start:dev` следит только за `src` |
| Миграции на `vitalo_dev` | только с разрешения пользователя (см. «Базы данных») |
| Выкладка на сервер | только пользователь сам: `git push server main` → `update.sh --check` → `update.sh` ([DEPLOY_RUNBOOK](docs/DEPLOY_RUNBOOK.md), «Шпаргалка») |

`git push server main` выкладывает ветку **main**: работу из `release-1` сначала нужно слить в `main`.

## Боты: локально только тестовый

| Бот | Где | Токен |
| --- | --- | --- |
| @vitalo_store_bot — **тестовый** | этот ноутбук (`apps\api\.env`) | проверено 29.10.2026: в локальном `.env` токен тестового бота |
| @vitalo_uz_bot — **боевой** | только сервер (`/opt/vitalo/app/apps/api/.env`) | никогда не класть на ноутбук |

- Локально — **только тестовый бот**, боевой токен — **только на сервере**. Два процесса с одним токеном мешают друг другу (409).
- Проверить, чей токен, не показывая его: запрос `getMe` к Telegram, вывести только `username`.
- Туннель (`start.bat` → окно «VITALO Tunnel») даёт адреса `https://…trycloudflare.com`. **Они меняются при каждом
  запуске**: бот сам переставляет кнопку «Магазин» и шлёт активным admin/manager из локальной базы «Новые адреса
  VITALO». Если в локальном `.env` вдруг окажется боевой токен — остановись и скажи пользователю, ничего не меняя.
- На сервере туннель не запускать: там постоянные адреса.

## Сервер (боевой)

- VPS Hostmaster (Узбекистан), Ubuntu 24.04, IP `91.213.99.230`. Данные магазина должны храниться в Узбекистане.
- Пользователи SSH: `saidkomolkhursandov` — администратор (sudo); `vitalo` — деплой и службы. Вход только по ключу.
- Отпечаток ключа сервера (не секрет, для сверки при первом входе): `ED25519 SHA256:yBrdO38Hvel7iiMHGJ1B3dVfKPXLgEiwiQHCvmAJbMw`.
- Папки: код `/opt/vitalo/app`, git-хранилище `/opt/vitalo/repo.git` (remote `server`), фото `/var/lib/vitalo`,
  настройки `/opt/vitalo/app/apps/api/.env`.
- Службы: `vitalo-api`, `vitalo-bot`, `vitalo-backup.timer` (каждую ночь 03:30, хранение 14 дней), nginx, postgresql.
  Перезапуск: `sudo systemctl restart vitalo-api vitalo-bot` (`update.sh` делает это сам).
- Адреса: `vitalo.uz` (Mini App), `admin.vitalo.uz`, `api.vitalo.uz`; проверка `https://api.vitalo.uz/api/health`.

## ПРАВИЛА для боевой среды

1. На сервере Claude ничего не меняет. Команды на изменение запускает только пользователь, по шагам из документации.
2. Перед любым изменением на сервере: git-тег выкладываемой версии **и** `pg_dump` боевой базы с копией на ноутбук.
3. Миграции — только добавляющие (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
   Никаких `DROP`, `DELETE`, переименований без отдельного решения пользователя.
4. Никогда не удалять товары, заказы, пользователей — только скрывать, архивировать или помечать.
5. Всё новое сначала проверяется локально на тестовом боте @vitalo_store_bot, потом выкладывается.
6. Только чтение на сервере (например, `SELECT` в режиме `default_transaction_read_only=on`, `systemctl is-active`) —
   допустимо, когда пользователь просит проверить состояние.

## СЕКРЕТЫ

Никогда не писать в `docs/`, в git, в сообщения и коммиты пароли, токены, ключи API, секреты оплат, номера карт и
имена владельцев карт. Они живут только в `.env` (ноутбук — `apps\api\.env`, сервер — свой `.env`). Шаблоны:
`.env.example`, `apps/api/.env.production.example` (без значений). Флешку с `.env` и SSH-ключом хранить как ключи от магазина.

## Базы данных

**Seed, тесты и скрипты — только на `vitalo_dev` и `vitalo_test`. На сервере — никогда без прямого разрешения пользователя.**

| База | Где | Что можно |
| --- | --- | --- |
| `vitalo_test` | Docker на компьютере | Автотесты (`npm run test:e2e`): каждый запуск очищает её и заполняет заново. Работать с ней можно без отдельного разрешения. |
| `vitalo_dev` | Docker на компьютере, `DATABASE_URL` в `apps/api/.env` | Рабочая база разработки с настоящими данными. `npm run seed`, `npx prisma db seed`, `ts-node prisma/seed.ts`, миграции и любые скрипты (`import:*`, `photos:*`, `staff:add`, `dev:*`) — только с прямого разрешения, каждый раз отдельно. |
| `vitalo` (старая локальная) | Docker на компьютере | Остаётся после переименования (`scripts/rename-local-db.ps1`) как запасная копия. Ничего не запускать и не удалять без разрешения. |
| `vitalo` на сервере | Production (91.213.99.230) | Настоящий магазин. Seed, тесты и dev-скрипты — никогда. Миграции, `update.sh`, `bootstrap:prod`, `staff:add`, `import:products` — только по прямому разрешению пользователя, и только он сам запускает их на сервере. |

- Разрешение спрашивай каждый раз отдельно; прошлое разрешение не переносится на следующий запуск.
- Защита в коде: seed и `dev:*` отказываются работать, если имя базы не оканчивается на `_dev` или `_test`,
  а также при `NODE_ENV=production` (`apps/api/src/common/db-target.ts`). Тесты принимают только базу `*_test`
  (`apps/api/test/test-env.ts`, `test/global-setup.ts`).
- На сервере `deploy/scripts/update.sh` не применяет миграции сам: только с `--migrate` или после ответа `yes`.
- Причина правил: повторный seed однажды перезаписал остатки и снял резервы открытых заказов в рабочей базе.

## Карта docs/

| Файл | Когда читать |
| --- | --- |
| [docs/PROGRESS.md](docs/PROGRESS.md) | всегда первым: где мы, статусы, ветки, открытые вопросы |
| [docs/ROADMAP.md](docs/ROADMAP.md) | что делаем дальше: релизы 1–4, админка, сайт |
| [docs/releases/release-1.md](docs/releases/release-1.md) | работа над релизом 1 (ТЗ и что уже сделано) |
| [docs/DECISIONS.md](docs/DECISIONS.md) | продуктовые решения D-xx: стиль, оплата, доставка, цены, языки |
| [docs/operations/DECISIONS.md](docs/operations/DECISIONS.md) | решения по складу, заказам, ролям, Яндексу (S-xx) — сверяться перед изменениями в них |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | стек, сервисы, база, API, домены, деплой, бэкапы |
| [docs/DEPLOY_RUNBOOK.md](docs/DEPLOY_RUNBOOK.md) | выкладка и работа на сервере; [DEPLOY.md](DEPLOY.md) — первая установка сервера |
| [docs/OPERATIONS_AUDIT.md](docs/OPERATIONS_AUDIT.md) | аудит кода к переходу на Operations |
| `docs/operations/*_REPORT.md` | отчёты этапов 2C–3, этикетки, Яндекс |
| [docs/PRINT_SETUP.md](docs/PRINT_SETUP.md) | печать этикеток |
