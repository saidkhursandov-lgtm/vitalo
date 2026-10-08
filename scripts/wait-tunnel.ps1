# Called by start.bat: waits until the dev tunnel (window "VITALO Tunnel") has written fresh public addresses to
# .runtime\miniapp-url.txt and .runtime\admin-url.txt, then prints them in large letters.
# -Since: unix time (seconds) when start.bat opened the tunnel window; 0 = the tunnel was already running, so the
#         addresses already in the files are the current ones.
# Exit code 0 = addresses shown, 1 = no addresses within -TimeoutSec.
param(
  [long]$Since = 0,
  [switch]$WithAdmin,
  [int]$TimeoutSec = 90
)

$root = Split-Path -Parent $PSScriptRoot
$files = @{ miniapp = Join-Path $root '.runtime\miniapp-url.txt'; admin = Join-Path $root '.runtime\admin-url.txt' }
$sinceTime = [DateTimeOffset]::FromUnixTimeSeconds($Since).LocalDateTime

function Read-FreshUrl([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  if ((Get-Item $path).LastWriteTime -lt $sinceTime) { return $null } # left over from the previous start
  $url = (Get-Content $path -Raw).Trim()
  if ($url -match '^https://[^\s]+$') { return $url } else { return $null }
}

Write-Host ''
Write-Host -NoNewline "Ожидание адресов туннеля (до $TimeoutSec с)"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
do {
  $miniapp = Read-FreshUrl $files.miniapp
  $admin = if ($WithAdmin) { Read-FreshUrl $files.admin } else { 'не используется' }
  if ($miniapp -and $admin) { break }
  Write-Host -NoNewline '.'
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
Write-Host ''

if (-not ($miniapp -and $admin)) {
  Write-Host ''
  Write-Host '############################################################' -ForegroundColor Red
  Write-Host "  ОШИБКА: туннель не дал адресов за $TimeoutSec секунд." -ForegroundColor Red
  Write-Host '  Откройте окно "VITALO Tunnel" и прочитайте сообщение.' -ForegroundColor Red
  Write-Host '  Частые причины: нет интернета, Cloudflare временно недоступен,' -ForegroundColor Red
  Write-Host '  не установлен cloudflared (winget install --id Cloudflare.cloudflared).' -ForegroundColor Red
  Write-Host '  Затем запустите stop.bat и start.bat ещё раз.' -ForegroundColor Red
  Write-Host '############################################################' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '############################################################' -ForegroundColor Green
Write-Host '  Туннель работает. Актуальные адреса:' -ForegroundColor Green
Write-Host ''
Write-Host "  Mini App: $miniapp" -ForegroundColor White
if ($WithAdmin) { Write-Host "  Админка:  $admin" -ForegroundColor White }
Write-Host ''
Write-Host '  Если адреса новые, администраторы и менеджеры получат в боте' -ForegroundColor Green
Write-Host '  сообщение "Новые адреса VITALO" с кнопками. Старые кнопки не работают.' -ForegroundColor Green
Write-Host '############################################################' -ForegroundColor Green
exit 0
