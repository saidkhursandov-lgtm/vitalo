<#
  VITALO, переезд на сервер (docs\DEPLOY_RUNBOOK.md, фаза 3): копия рабочей базы vitalo_dev для сервера.

  Как запустить (из корня проекта, в PowerShell), ПОСЛЕ stop.bat:
    powershell -ExecutionPolicy Bypass -File scripts\export-dev-db.ps1

  Что делает:
    1. Проверяет: Docker работает, API остановлен (иначе копия может застать изменение на полпути).
    2. Проверяет, что в vitalo_dev применены все миграции из папки проекта.
    3. Делает копию (pg_dump) в backups\vitalo_dev-for-server-<дата>.dump и проверяет, что она читается.
    4. Печатает числа для сверки на сервере: товары, банки, остаток, заказы.
  Базу vitalo_dev скрипт только ЧИТАЕТ. Пароли на экран не выводятся. На сервер ничего не отправляет.
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Db = 'vitalo_dev'
$DbUser = 'vitalo'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$File = "vitalo_dev-for-server-$Stamp.dump"

function Step([int]$n, [string]$text) {
  Write-Host ''
  Write-Host "[$n/4] $text" -ForegroundColor Cyan
}
function Fail([string]$text) {
  Write-Host ''
  Write-Host "ОСТАНОВЛЕНО: $text" -ForegroundColor Red
  Write-Host 'База не менялась.'
  exit 1
}
function Sql([string]$query) {
  $out = docker compose exec -T postgres psql -U $DbUser -d $Db -X -At -c $query
  if ($LASTEXITCODE -ne 0) { Fail "запрос к базе $Db не выполнился" }
  return $out
}

Step 1 'Проверки'
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker не запущен. Запустите Docker Desktop и повторите.' }
docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up -d postgres не сработал' }
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) { Fail 'API ещё работает (порт 3000 занят). Сначала выполните stop.bat.' }
$ready = $false
foreach ($i in 1..30) {
  docker compose exec -T postgres pg_isready -U $DbUser -d $Db *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { Fail "база $Db не отвечает" }
Write-Host 'Docker работает, API остановлен, база отвечает.'

Step 2 'Миграции'
$inCode = @(Get-ChildItem -Directory (Join-Path $Root 'apps\api\prisma\migrations') | ForEach-Object { $_.Name } | Sort-Object)
$inDb = @(Sql 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1')
$missing = @($inCode | Where-Object { $inDb -notcontains $_ })
if ($missing.Count -gt 0) {
  Write-Host 'В базе vitalo_dev ещё не применены миграции:' -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "  $_" }
  Fail 'сначала примените миграции к vitalo_dev (после бэкапа, как в отчётах этапов) и проверьте магазин.'
}
Write-Host "Применены все миграции ($($inCode.Count)). Последняя: $($inCode[-1])"

Step 3 'Копия базы'
New-Item -ItemType Directory -Force (Join-Path $Root 'backups') | Out-Null
docker compose exec -T postgres pg_dump -U $DbUser -d $Db --format=custom --no-owner --no-acl --file "/tmp/$File"
if ($LASTEXITCODE -ne 0) { Fail 'pg_dump завершился с ошибкой' }
docker compose exec -T postgres pg_restore --list "/tmp/$File" *> $null
if ($LASTEXITCODE -ne 0) { Fail 'копия не читается' }
docker compose cp "postgres:/tmp/$File" "backups\$File"
if ($LASTEXITCODE -ne 0) { Fail 'не удалось забрать файл копии из контейнера' }
docker compose exec -T postgres rm -f "/tmp/$File" *> $null
$size = [math]::Round((Get-Item "backups\$File").Length / 1MB, 1)
Write-Host "Готово: backups\$File ($size МБ)" -ForegroundColor Green

Step 4 'Числа для сверки на сервере (запишите или оставьте это окно открытым)'
$rows = @(
  @('товаров', 'SELECT count(*) FROM products'),
  @('банок (Physical ID)', 'SELECT count(*) FROM physical_units'),
  @('банок на полке', "SELECT count(*) FROM physical_units WHERE status IN ('IN_STOCK','ASSIGNED')"),
  @('остаток по количеству', 'SELECT coalesce(sum(actual_qty),0) FROM inventory'),
  @('альтернативных SKU', 'SELECT count(*) FROM product_sku_aliases'),
  @('заказов VITALO', 'SELECT count(*) FROM orders'),
  @('  из них с пометкой «тест»', 'SELECT count(*) FROM orders WHERE is_test'),
  @('заказов Яндекса', 'SELECT count(*) FROM marketplace_orders'),
  @('  из них с пометкой «тест»', 'SELECT count(*) FROM marketplace_orders WHERE is_test'),
  @('покупателей', 'SELECT count(*) FROM users'),
  @('сотрудников', 'SELECT count(*) FROM staff_users')
)
foreach ($r in $rows) { Write-Host ('  {0,-30} {1,10}' -f $r[0], (Sql $r[1])) }

Write-Host ''
Write-Host 'Дальше — по инструкции docs\DEPLOY_RUNBOOK.md, фаза 3: отправка файла на сервер.'
Write-Host 'ВАЖНО: после этой копии ничего не меняйте в vitalo_dev (не принимайте товар, не собирайте заказы),' -ForegroundColor Yellow
Write-Host 'пока сервер не заработает: изменения, сделанные после копии, на сервер не попадут.' -ForegroundColor Yellow
