# VITALO — запуск на сервере

> Это инструкция **первой установки** сервера с нуля. Переезд текущей версии и данных на уже настроенный сервер —
> в [docs/DEPLOY_RUNBOOK.md](docs/DEPLOY_RUNBOOK.md).

Инструкция по настройке **уже арендованного** сервера и выкладке магазина.

| Что | Значение |
| --- | --- |
| Сервер | Ubuntu 24.04 LTS, IP `91.213.99.230` |
| Магазин (Mini App) | https://vitalo.uz |
| Админ-панель | https://admin.vitalo.uz |
| API | https://api.vitalo.uz |
| DNS | A-записи всех трёх имён указывают на `91.213.99.230` (уже настроено) |
| Бот | рабочий бот, отдельный от тестового |

> **Главное правило.** Пароли, токены и ключи вводятся **только на сервере** (в редакторе `nano` или
> командами, которые сами создают значение и сразу записывают его в файл). Не присылайте их в чат,
> не вставляйте в код и не коммитьте. В этой инструкции на их месте стоят пометки вида `<…>`.

## Как всё устроено

```
Telegram ──► https://vitalo.uz ─┐
Админы ───► https://admin.vitalo.uz ─┼─► nginx (HTTPS, порты 80/443) ──► API 127.0.0.1:3000 ──► PostgreSQL
                  https://api.vitalo.uz ─┘          │ /uploads → /var/lib/vitalo/uploads (фото)
                                                    └ сайты: собранные файлы из apps/miniapp/dist, apps/admin/dist
Бот (служба vitalo-bot) ──► API на 127.0.0.1 ──► Telegram (long polling, входящие порты не нужны)
```

- Код лежит в `/opt/vitalo/app`. Вы отправляете его со своего компьютера командой `git push` прямо на сервер,
  без GitHub и других сервисов.
- API и бот работают как службы systemd от пользователя `vitalo`. Они сами поднимаются после перезагрузки.
- База PostgreSQL установлена на этом же сервере. Пароль базы не нужен: API подключается через локальный сокет
  от имени системного пользователя `vitalo`.
- Каждую ночь делаются резервные копии базы и фото. Перед каждым обновлением дополнительно сохраняется база.

Все файлы конфигурации уже лежат в репозитории, в папке `deploy/`:

| Файл | Куда на сервере |
| --- | --- |
| `deploy/nginx/vitalo-http.conf` | временно, до получения сертификата |
| `deploy/nginx/vitalo.conf` | `/etc/nginx/sites-available/vitalo.conf` |
| `deploy/nginx/snippets/*.conf` | `/etc/nginx/snippets/` |
| `deploy/systemd/*.service`, `*.timer` | `/etc/systemd/system/` |
| `deploy/sudoers-vitalo` | `/etc/sudoers.d/vitalo` |
| `apps/api/.env.production.example` | шаблон для `/opt/vitalo/app/apps/api/.env` |
| `deploy/scripts/update.sh` | обновление сайта; миграции базы — только с `--migrate` (раздел 13) |
| `deploy/scripts/backup.sh` | резервная копия (сам скрипт — `scripts/server/backup.sh`) |
| `scripts/server/*.sh` | проверки сервера, бэкап, проверка восстановления, перенос базы — см. `docs/DEPLOY_RUNBOOK.md` |

---

## 1. Ключ SSH на вашем компьютере (один раз)

В PowerShell на Windows:

```powershell
ssh-keygen -t ed25519 -C "vitalo-pc"
```

На вопросы можно нажимать Enter. Лучше задать фразу-пароль для ключа — тогда украденный файл ключа бесполезен.
Появятся два файла: `C:\Users\<вы>\.ssh\id_ed25519` (**секретный, никому не давать**) и
`id_ed25519.pub` (открытый, его можно копировать на сервер).

Показать открытый ключ, чтобы скопировать:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

## 2. Первый вход и защита сервера

**Как это было у hostmaster.** Выданные логины `root` и `admin` не подошли: в Cloud-Init ВМ не задан ни пароль,
ни ключ, а менять Cloud-Init клиенту нельзя. Рабочий вход — пользователь с вашим именем (`saidkomolkhursandov`,
у него есть `sudo`), и вход им работает только через экран сервера в браузере:

1. https://vnc.hostmaster.uz → логин `vnc-…` из письма, Realm «Proxmox VE authentication server».
2. ВМ 576 → **Консоль** (или «Консоль ▾ → noVNC» в отдельном окне). Щёлкните в чёрное поле, включите английскую раскладку.
3. `vitalo login:` → имя пользователя, затем его пароль. Ввод пароля не виден.

Затем на этом экране временно разрешите вход по паролю, чтобы один раз передать ключ:

```bash
sudo bash -c 'echo "PasswordAuthentication yes" > /etc/ssh/sshd_config.d/01-temp.conf && systemctl restart ssh'
```

На компьютере, в PowerShell, передайте открытый ключ (спросит пароль пользователя) и проверьте вход по ключу:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh saidkomolkhursandov@91.213.99.230 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
ssh saidkomolkhursandov@91.213.99.230
```

Дальше все команды выполняются **на сервере**, после `sudo -i` (строка `root@vitalo:~#`).
Временный файл `01-temp.conf` удаляется в шаге 2.2. Если сервер выдан с рабочим `root`, вместо всего этого
войдите `ssh root@91.213.99.230` и создайте пользователя по шагу 2.2.

### 2.1 Обновления, часовой пояс, подкачка

```bash
apt update && apt -y upgrade
timedatectl set-timezone Asia/Tashkent
apt -y install unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades
```

Если на сервере 2 ГБ памяти или меньше, сборка сайта может не поместиться. Добавьте файл подкачки на 2 ГБ:

```bash
free -h
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 2.2 Ваш пользователь-администратор (вместо root)

У hostmaster он уже есть (`saidkomolkhursandov`) — пропустите создание и сразу закройте вход по паролю
(блок с `00-vitalo.conf` ниже, перед ним `rm -f /etc/ssh/sshd_config.d/01-temp.conf`). Если создаёте сами:

```bash
adduser vadmin
usermod -aG sudo vadmin
mkdir -p /home/vadmin/.ssh && nano /home/vadmin/.ssh/authorized_keys
```

`adduser` попросит придумать пароль. Он нужен для `sudo`, храните его в менеджере паролей.
В открывшийся `nano` вставьте **открытый** ключ из шага 1 (строка `ssh-ed25519 …`), затем Ctrl+O, Enter, Ctrl+X.

```bash
chown -R vadmin:vadmin /home/vadmin/.ssh && chmod 700 /home/vadmin/.ssh && chmod 600 /home/vadmin/.ssh/authorized_keys
```

**Не закрывая текущее окно**, откройте второе окно PowerShell и проверьте вход по ключу:

```powershell
ssh vadmin@91.213.99.230
```

Работает? Тогда отключите вход по паролю и вход под root (команды выполняйте во втором окне):

```bash
# имя 00-… важно: из файлов этой папки действует первое значение, а хостинг может положить свой 50-cloud-init.conf
sudo rm -f /etc/ssh/sshd_config.d/01-temp.conf
sudo tee /etc/ssh/sshd_config.d/00-vitalo.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

### 2.3 Брандмауэр и защита от перебора паролей

```bash
sudo apt -y install ufw fail2ban
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
sudo systemctl enable --now fail2ban
```

Порты 3000 (API) и 5432 (база) снаружи закрыты. API к тому же слушает только `127.0.0.1`.

## 3. Программы

```bash
sudo apt -y install git nginx postgresql certbot curl ca-certificates build-essential
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs
node -v && npm -v && psql --version && nginx -v
```

Должно получиться: Node.js 24.x, PostgreSQL 16, nginx 1.24 или новее.

## 4. Пользователь `vitalo`, папки, база

```bash
sudo useradd --system --create-home --home-dir /opt/vitalo --shell /bin/bash --user-group vitalo
sudo usermod -p '*' vitalo   # без пароля, но вход по ключу разрешён
sudo mkdir -p /var/lib/vitalo/uploads /var/backups/vitalo /opt/vitalo/import /opt/vitalo/.ssh /var/www/certbot
sudo chown -R vitalo:vitalo /opt/vitalo /var/lib/vitalo /var/backups/vitalo
sudo chmod 750 /opt/vitalo /var/lib/vitalo && sudo chmod 700 /var/backups/vitalo
# nginx (www-data) читает собранный сайт и фото через группу vitalo
sudo usermod -aG vitalo www-data
```

Ваш ключ для отправки кода — тот же, что у вашего пользователя-администратора:

```bash
sudo install -o vitalo -g vitalo -m 600 /home/saidkomolkhursandov/.ssh/authorized_keys /opt/vitalo/.ssh/authorized_keys
sudo chown vitalo:vitalo /opt/vitalo/.ssh && sudo chmod 700 /opt/vitalo/.ssh
```

База данных (роль `vitalo` без пароля, вход только с этого сервера через сокет):

```bash
sudo -u postgres createuser vitalo
sudo -u postgres createdb -O vitalo vitalo
```

## 5. Код на сервер

На сервере создайте хранилище, куда вы будете отправлять код:

```bash
sudo -iu vitalo git init --bare /opt/vitalo/repo.git
# иначе хранилище ждёт ветку master и копия скачается пустой
sudo -iu vitalo git -C /opt/vitalo/repo.git symbolic-ref HEAD refs/heads/main
```

На вашем компьютере, в PowerShell, в папке проекта (git в PowerShell вызывается по полному пути):

```powershell
cd C:\Users\PC_LENOVO\Documents\VITALO\vitalo
& "C:\Program Files\Git\cmd\git.exe" remote add server vitalo@91.213.99.230:/opt/vitalo/repo.git
& "C:\Program Files\Git\cmd\git.exe" push server main
```

`.env`, папки `photos/`, `uploads/` и файл Excel в git не попадают: они перечислены в `.gitignore`.

На сервере разверните рабочую копию:

```bash
sudo -iu vitalo git clone /opt/vitalo/repo.git /opt/vitalo/app
```

## 6. Файл настроек `.env`

Файл из шаблона и секрет между ботом и API (создаётся и записывается сразу, на экран не выводится):

```bash
sudo -iu vitalo bash -c 'cd /opt/vitalo/app/apps/api && cp .env.production.example .env && chmod 600 .env && sed -i "s/^BOT_API_SECRET=.*/BOT_API_SECRET=$(openssl rand -hex 32)/" .env && echo "ФАЙЛ СОЗДАН"'
```

Токен **рабочего** бота (@BotFather → `/mybots` → бот → API Token; копировать на этом же компьютере).
Команда ждёт вставку правой кнопкой мыши и Enter. Ввод не виден, пустую или неверную вставку команда пропускает
и спрашивает снова (вопрос может появиться дважды — это лишний Enter от вставки самой команды):

```bash
F=/opt/vitalo/app/apps/api/.env; while :; do read -rsp "Paste token, then Enter: " T; echo; T="${T//[[:space:]]/}"; [[ "$T" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] && break; [ -n "$T" ] && echo "Не похоже на токен (${#T} символов). Скопируйте ещё раз."; done; sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$T|" $F; chown vitalo:vitalo $F; chmod 600 $F; unset T; echo "ТОКЕН ЗАПИСАН"
```

Всё остальное в шаблоне уже под ваш сервер: адреса, папка фото, подключение к базе. `TECH_CHAT_ID` — раздел 11.
Проверка без показа значений (должны вывестись два имени):

```bash
grep -E '^(TELEGRAM_BOT_TOKEN|BOT_API_SECRET)=.+' /opt/vitalo/app/apps/api/.env | cut -d= -f1
```

## 7. Службы

```bash
cd /opt/vitalo/app
sudo cp deploy/systemd/vitalo-api.service deploy/systemd/vitalo-bot.service deploy/systemd/vitalo-backup.service deploy/systemd/vitalo-backup.timer /etc/systemd/system/
sudo install -m 440 deploy/sudoers-vitalo /etc/sudoers.d/vitalo && sudo visudo -c
sudo systemctl daemon-reload
sudo systemctl enable vitalo-api vitalo-bot
sudo systemctl enable --now vitalo-backup.timer
```

Службы пока не запущены. Их запустит сборка в следующем шаге.

## 8. Первая сборка и начальные данные

```bash
sudo -iu vitalo /opt/vitalo/app/deploy/scripts/update.sh --migrate
```

На пустой базе нужен флаг `--migrate`: без него скрипт покажет список миграций и остановится (раздел 13).

Скрипт:
1. делает копию базы;
2. ставит зависимости;
3. применяет миграции — 14 регионов, города, тестовые тарифы, тексты оферты 0.1-test;
4. собирает API, магазин и админку;
5. запускает службы и проверяет, что API отвечает.

В конце должно быть «API отвечает. Готово.»

Справочники магазина: категории, способы оплаты, склад в Ташкенте, настройки по умолчанию.

```bash
sudo -iu vitalo bash -c 'cd /opt/vitalo/app/apps/api && npm run bootstrap:prod'
```

> Здесь используется **только** `bootstrap:prod`. Он не создаёт ни товаров, ни покупателей, ни сотрудников,
> и его можно запускать повторно. Демо-заполнение `npm run seed` с тестовыми товарами и сотрудниками на сервере
> не запустится: при `NODE_ENV=production` оно само отказывается работать. Тесты на сервере не запускайте.

Первый администратор. Ваш Telegram ID можно узнать у @userinfobot.

```bash
sudo -iu vitalo bash -c 'cd /opt/vitalo/app/apps/api && npm run staff:add -- --telegram-id <ВАШ_TELEGRAM_ID> --name "<Имя>" --role admin'
```

## 9. Сайты и HTTPS

Сначала временный сайт для получения сертификата:

```bash
cd /opt/vitalo/app
sudo cp deploy/nginx/vitalo-http.conf /etc/nginx/sites-available/vitalo.conf
sudo ln -sf /etc/nginx/sites-available/vitalo.conf /etc/nginx/sites-enabled/vitalo.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Один сертификат Let's Encrypt на три адреса (укажите свой e-mail для писем о продлении):

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d vitalo.uz -d admin.vitalo.uz -d api.vitalo.uz \
  --email <ваш_email> --agree-tos --no-eff-email
```

Рабочая конфигурация:

```bash
sudo cp deploy/nginx/snippets/vitalo-common.conf deploy/nginx/snippets/vitalo-api-proxy.conf /etc/nginx/snippets/
sudo cp deploy/nginx/vitalo.conf /etc/nginx/sites-available/vitalo.conf
sudo nginx -t && sudo systemctl reload nginx
```

Автопродление: certbot уже установил таймер. Добавьте перезагрузку nginx после продления и проверьте:

```bash
echo 'systemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

Если нужен ещё `www.vitalo.uz`, сначала добавьте для него A-запись в DNS. Затем допишите
`-d www.vitalo.uz` в команду certbot (с флагом `--expand`) и само имя — в `server_name` сайта магазина.

## 10. Рабочий бот в @BotFather

- Кнопку меню «Магазин» бот ставит сам при запуске, адрес он берёт из `MINIAPP_URL`.
- Рекомендуется включить: **Bot Settings → Configure Mini App → Enable Mini App**, адрес `https://vitalo.uz`.
  Тогда работают ссылки вида `t.me/<бот>?startapp=…` и кнопка «Открыть» в профиле бота.
- Описание бота, аватар, список команд — по желанию: `/setdescription`, `/setuserpic`.
  Команды бот тоже ставит сам.

Проверка: напишите рабочему боту `/start` → «Магазин» → откроется https://vitalo.uz. Команда `/admin`
откроет админку: кнопка есть только у сотрудников из раздела 8.

## 11. Технический чат для ошибок

1. В Telegram создайте группу, например «VITALO тех», и добавьте в неё **рабочего** бота.
2. Добавьте туда же @RawDataBot. Он пришлёт данные чата: число после `"id":` (обычно начинается с `-100`)
   и есть ID чата. Затем удалите @RawDataBot из группы.
3. На сервере впишите ID и перезапустите API:

```bash
sudo -iu vitalo nano /opt/vitalo/app/apps/api/.env      # TECH_CHAT_ID=-100…
sudo systemctl restart vitalo-api
```

## 12. Наполнение магазина перед запуском

В админке https://admin.vitalo.uz (вход через бота, команда `/admin`):

- [ ] **Настройки → «Перевод на карту» и «Перевод по реквизитам»:** настоящий номер карты, получатель,
  банковские реквизиты. Сейчас там стоят значения с пометкой ТЕСТ.
- [ ] **Настройки → доставка («Города и районы»):** цены и сроки всех 14 регионов, снимите отметку «тестовый».
- [ ] **Настройки → «Поддержка и время работы»:** контакт поддержки, часы проверки платежей.
- [ ] **Настройки → документы:** версия 1.0 оферты и политики (без полей `[ ]`, проверенная юристом),
  опубликовать. Версия 0.1-test — только для проверки.
- [ ] **Настройки → главная:** «Баннер», «Плитки доверия», «Как заказать».
- [ ] **Сотрудники («Новый сотрудник»):** менеджеры и склад с нужными ролями.

Товары из Excel. Файл и фото копируются с вашего компьютера в PowerShell:

```powershell
cd C:\Users\PC_LENOVO\Documents\VITALO\vitalo
scp .\VITALO_товары.xlsx vitalo@91.213.99.230:/opt/vitalo/import/
scp -r .\photos vitalo@91.213.99.230:/opt/vitalo/import/
```

На сервере сначала запустите проверку — она ничего не записывает:

```bash
sudo -iu vitalo bash -c 'cd /opt/vitalo/app/apps/api && npm run import:products -- --file /opt/vitalo/import/VITALO_товары.xlsx --photos /opt/vitalo/import/photos'
```

Если ошибок нет, запустите загрузку: та же команда, в конце добавьте ` --confirm`.
Фото при загрузке сразу сжимаются (WebP 1200 px и миниатюра 400 px). Повторный запуск не создаёт дублей.

## 13. Обновления

На компьютере, после изменений в коде:

```powershell
& "C:\Program Files\Git\cmd\git.exe" push server main
```

На сервере сначала посмотрите, что придёт (ничего не меняется):

```bash
sudo -iu vitalo /opt/vitalo/app/deploy/scripts/update.sh --check
```

Затем обновите:

```bash
sudo -iu vitalo /opt/vitalo/app/deploy/scripts/update.sh
```

**Миграции базы сами больше не применяются.**
- Если в новом коде нет новых миграций, скрипт обновляет код, собирает и перезапускает службы, как раньше.
- Если новые миграции есть, скрипт делает копию базы, показывает их список и **останавливается**: код и службы не меняются, магазин работает как раньше.
- Если вы запустили его сами в окне терминала, он спросит «Применить эти миграции?». Только ответ `yes` продолжит обновление.

Применить миграции осознанно (копия базы делается перед этим автоматически):

```bash
sudo -iu vitalo /opt/vitalo/app/deploy/scripts/update.sh --migrate
```

Перед `--migrate` спросите разработчика, что делают эти миграции. В проекте миграции только добавляют колонки и данные, но проверять нужно каждый раз.

Магазин продолжает работать во время сборки, служба перезапускается за несколько секунд.
Если среди изменений были файлы из `deploy/nginx` или `deploy/systemd`, их нужно скопировать заново
(шаги 7 и 9) и выполнить `sudo nginx -t && sudo systemctl reload nginx` или `sudo systemctl daemon-reload`.

## 14. Резервные копии

- Копии делаются каждую ночь в 03:30 в `/var/backups/vitalo` и хранятся 14 дней:
  база `db-*.dump` и фото `uploads-*.tar.gz`.
- Ещё одна копия базы делается перед каждым обновлением.
- Хотя бы раз в неделю забирайте копии к себе — если сервер пропадёт целиком, копии на нём не помогут:

```powershell
scp "vitalo@91.213.99.230:/var/backups/vitalo/db-*.dump" D:\VITALO-backups\
```

Проверить таймер и сделать копию вручную:

```bash
systemctl list-timers vitalo-backup.timer
sudo -iu vitalo /opt/vitalo/app/deploy/scripts/backup.sh
```

Восстановление базы из копии. Делайте это только при реальной потере данных: сначала остановите API.

```bash
sudo systemctl stop vitalo-api vitalo-bot
sudo -iu vitalo pg_restore --clean --if-exists --no-owner -d vitalo /var/backups/vitalo/db-<ДАТА>.dump
sudo systemctl start vitalo-api vitalo-bot
```

Фото восстанавливаются так: `tar -xzf uploads-<ДАТА>.tar.gz -C /var/lib/vitalo` (от пользователя `vitalo`).

## 15. Проверка после запуска

```bash
systemctl status vitalo-api vitalo-bot --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' https://vitalo.uz
curl -sS -o /dev/null -w '%{http_code}\n' https://admin.vitalo.uz
curl -sS https://api.vitalo.uz/api/delivery/terms
curl -sS -o /dev/null -w '%{http_code}\n' https://api.vitalo.uz/api/docs        # 404: документация API скрыта
curl -sS -o /dev/null -w '%{http_code}\n' https://api.vitalo.uz/api/internal/bot/info   # 404: внутренний вход бота закрыт
```

Ожидается: `200`, `200`, сроки доставки в JSON, `404`, `404`.

Дальше в Telegram с телефона пройдите весь путь покупателя:
1. Рабочий бот → «Магазин» → экран согласия с офертой.
2. Каталог → «В корзину» → оформление.
3. «Перевод на карту» → «Я оплатил(а)».
4. В админке «Подтвердить оплату» → клиенту в боте приходит «Оплачен».

## 16. Если что-то не работает

| Признак | Где смотреть |
| --- | --- |
| Сайт не открывается | `sudo nginx -t`, `sudo tail -n 50 /var/log/nginx/error.log` |
| «Нет связи» в магазине, 502 | `journalctl -u vitalo-api -n 100 --no-pager` |
| Бот молчит | `journalctl -u vitalo-bot -n 100 --no-pager`; токен в `.env` именно рабочего бота? |
| Вход в админку не пускает | сотрудник добавлен командой `staff:add` с вашим Telegram ID? |
| Ошибка миграции при обновлении | вывод `update.sh --migrate`. Копия базы до обновления лежит в `/var/backups/vitalo` |
| `update.sh` остановился со словом «ОСТАНОВЛЕНО» | Это не ошибка: в новом коде есть миграции базы. Магазин работает по-старому; применить — `update.sh --migrate` |

Откат кода на предыдущую версию: на компьютере отмените последний коммит, отправьте и обновите как обычно
(раздел 13). База при этом не откатывается — миграции в проекте только добавляют, старый код с ними работает.

```powershell
& "C:\Program Files\Git\cmd\git.exe" revert --no-edit HEAD
& "C:\Program Files\Git\cmd\git.exe" push server main
```

## Базы данных: где какая

| Где | База | Для чего |
| --- | --- | --- |
| Сервер | `vitalo` | Настоящий магазин. Seed, тесты и dev-скрипты здесь не запускаются никогда. |
| Компьютер разработчика | `vitalo_dev` | Рабочая база для разработки (раньше называлась `vitalo`; переименование — `scripts/rename-local-db.ps1`) |
| Компьютер разработчика | `vitalo_test` | Автотесты: каждый запуск очищает её и заполняет заново |

Demo-seed и скрипты `dev:*` работают только с базой, чьё имя оканчивается на `_dev` или `_test`, и отказываются при `NODE_ENV=production`.
Скрипты `staff:add`, `import:products`, `photos:optimize`, `bootstrap:prod` в начале печатают, к какой базе подключаются (без пароля).

## Чего на сервере не делать

- Не запускать `npm run seed`, тесты (`npm test`, `npm run test:e2e`) и скрипты разработки.
- Не показывать содержимое `.env` (`cat .env`) при демонстрации экрана и не пересылать его.
- Не открывать в брандмауэре порты 3000 и 5432.
- Не использовать токен тестового бота на сервере и рабочий токен — на компьютере.
