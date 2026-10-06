<#
  VITALO: локальная рабочая база vitalo -> vitalo_dev (Этап 0.5).
  Делает КОПИЮ: старая база vitalo остаётся на месте и не удаляется.

  Как запустить (из корня проекта, в PowerShell):
    1) .\stop.bat
    2) powershell -ExecutionPolicy Bypass -File scripts\rename-local-db.ps1
    3) .\start.bat и проверка магазина и админки

  Что делает:
    1. Проверяет: Docker работает, API остановлен, файл apps\api\.env есть.
    2. Запускает только контейнер postgres и ждёт его.
    3. Проверяет: база vitalo есть, vitalo_dev ещё нет, к vitalo никто не подключён.
    4. Копия базы vitalo (pg_dump) -> папка backups\ в проекте.
    5. CREATE DATABASE vitalo_dev TEMPLATE vitalo (точная копия).
    6. Сравнивает количество строк в главных таблицах обеих баз.
    7. В apps\api\.env меняет имя базы в DATABASE_URL на vitalo_dev (старый .env сохраняется рядом).
  Пароли на экран не выводятся. Production (сервер) этот скрипт не трогает.
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Old = 'vitalo'
$New = 'vitalo_dev'
$DbUser = 'vitalo'
$EnvFile = Join-Path $Root 'apps\api\.env'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmm'

function Step([int]$n, [string]$text) {
  Write-Host ''
  Write-Host "[$n/7] $text" -ForegroundColor Cyan
}
function Fail([string]$text) {
  Write-Host ''
  Write-Host "ОСТАНОВЛЕНО: $text" -ForegroundColor Red
  Write-Host 'Ничего не удалено. Если база vitalo_dev уже создана, она просто лежит рядом со старой.'
  exit 1
}
# One value (or several lines) from psql inside the postgres container. Connects to the service DB "postgres"
# unless another one is given, so it never holds a connection to vitalo itself.
function Sql([string]$sql, [string]$db = 'postgres') {
  $out = docker compose exec -T postgres psql -U $DbUser -d $db -X -A -t -c $sql
  if ($LASTEXITCODE -ne 0) { Fail "запрос к базе не выполнился: $sql" }
  return (($out | Out-String).Trim())
}

# ---------------------------------------------------------------- 1
Step 1 'Проверки перед началом'
if (-not (Test-Path (Join-Path $Root 'docker-compose.yml'))) { Fail 'запустите скрипт из папки проекта VITALO (там, где docker-compose.yml)' }
if (-not (Test-Path $EnvFile)) { Fail 'нет файла apps\api\.env' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker не запущен. Откройте Docker Desktop и дождитесь, пока он запустится.' }
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) { Fail 'API ещё работает (порт 3000 занят). Сначала выполните .\stop.bat' }
Write-Host 'Docker работает, API остановлен.'

# ---------------------------------------------------------------- 2
Step 2 'Запуск контейнера базы данных'
docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up -d postgres не сработал' }
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker compose exec -T postgres pg_isready -U $DbUser -d postgres *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { Fail 'PostgreSQL не ответил за 60 секунд' }
Write-Host 'База данных готова.'

# ---------------------------------------------------------------- 3
Step 3 'Проверка баз'
if ((Sql "SELECT count(*) FROM pg_database WHERE datname = '$Old'") -ne '1') { Fail "базы $Old нет — переименовывать нечего" }
if ((Sql "SELECT count(*) FROM pg_database WHERE datname = '$New'") -ne '0') {
  Fail "база $New уже существует. Если переименование уже делалось, проверьте DATABASE_URL в apps\api\.env (должна быть $New)."
}
$conn = Sql "SELECT count(*) FROM pg_stat_activity WHERE datname = '$Old'"
if ($conn -ne '0') { Fail "к базе $Old подключено программ: $conn. Закройте всё (.\stop.bat, окна VITALO, pgAdmin) и запустите скрипт снова." }
Write-Host "База $Old есть, $New ещё нет, к $Old никто не подключён."

# ---------------------------------------------------------------- 4
Step 4 "Резервная копия базы $Old"
$BackupDir = Join-Path $Root 'backups'
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$DumpName = "$Old-before-rename-$Stamp.dump"
docker compose exec -T postgres pg_dump -U $DbUser -d $Old --format=custom --file "/tmp/$DumpName"
if ($LASTEXITCODE -ne 0) { Fail 'pg_dump не выполнился' }
docker compose cp "postgres:/tmp/$DumpName" (Join-Path $BackupDir $DumpName)
if ($LASTEXITCODE -ne 0) { Fail 'не удалось скопировать копию базы из контейнера' }
docker compose exec -T postgres rm -f "/tmp/$DumpName" | Out-Null
$size = (Get-Item (Join-Path $BackupDir $DumpName)).Length
if ($size -lt 1024) { Fail "копия базы подозрительно маленькая ($size байт)" }
Write-Host ("Копия: backups\{0} ({1:N0} КБ)" -f $DumpName, ($size / 1KB))

# ---------------------------------------------------------------- 5
Step 5 "Создание $New как копии $Old"
Sql "CREATE DATABASE $New TEMPLATE $Old OWNER $DbUser" | Out-Null
Write-Host "База $New создана."

# ---------------------------------------------------------------- 6
Step 6 'Сравнение баз'
$checks = [ordered]@{
  'товары'               = 'SELECT count(*) FROM products'
  'заказы'               = 'SELECT count(*) FROM orders'
  'строки заказов'       = 'SELECT count(*) FROM order_items'
  'покупатели'           = 'SELECT count(*) FROM users'
  'сотрудники'           = 'SELECT count(*) FROM staff_users'
  'фото товаров'         = 'SELECT count(*) FROM product_media'
  'движения склада'      = 'SELECT count(*) FROM inventory_movements'
  'остаток (сумма)'      = 'SELECT coalesce(sum(actual_qty), 0) FROM inventory'
  'резерв (сумма)'       = 'SELECT coalesce(sum(reserved_qty), 0) FROM inventory'
  'применённые миграции' = 'SELECT count(*) FROM _prisma_migrations'
}
$diff = $false
foreach ($k in $checks.Keys) {
  $a = Sql $checks[$k] $Old
  $b = Sql $checks[$k] $New
  $mark = if ($a -eq $b) { 'ok' } else { $diff = $true; 'РАЗНИЦА' }
  Write-Host ("  {0,-22} {1,8} | {2,8}  {3}" -f $k, $a, $b, $mark)
}
if ($diff) { Fail "базы различаются. .env не изменён: приложение по-прежнему работает со старой базой $Old." }
Write-Host 'Базы совпадают.'

# ---------------------------------------------------------------- 7
Step 7 'Переключение apps\api\.env на vitalo_dev'
$text = [IO.File]::ReadAllText($EnvFile)
$pattern = '(?m)^(DATABASE_URL=\S*?/)' + $Old + '(?=[?\s#]|$)'
if (-not [regex]::IsMatch($text, $pattern)) {
  Fail "в apps\api\.env не нашлась строка DATABASE_URL с базой $Old. Поменяйте имя базы в конце DATABASE_URL на $New вручную (база $New уже готова)."
}
$EnvBackup = "$EnvFile.bak-$Stamp"
Copy-Item $EnvFile $EnvBackup
$text = [regex]::Replace($text, $pattern, '${1}' + $New, 1)
[IO.File]::WriteAllText($EnvFile, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "DATABASE_URL: база $Old -> $New (старый файл: apps\api\$(Split-Path -Leaf $EnvBackup))"

Write-Host ''
Write-Host 'ГОТОВО.' -ForegroundColor Green
Write-Host "Дальше:"
Write-Host '  1. Запустите .\start.bat'
Write-Host '  2. Откройте магазин и админку: товары, заказы, остатки должны быть на месте.'
Write-Host "  3. Старая база $Old не удалена. Удалять её не нужно, пока вы не убедитесь, что всё работает."
Write-Host "  Вернуть как было: скопируйте apps\api\$(Split-Path -Leaf $EnvBackup) обратно в apps\api\.env"
