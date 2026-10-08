@echo off
setlocal
rem ============================================================
rem  VITALO - start the local development environment:
rem  Docker Desktop -> PostgreSQL + Redis -> API, Mini App, Admin, Bot
rem  and (if cloudflared is installed) the public HTTPS tunnel, each in its own window.
rem  Stop everything with stop.bat
rem ============================================================
title VITALO start
cd /d "%~dp0"
set "ROOT=%~dp0"

echo.
echo === VITALO: starting local environment ===
echo.

rem ---------- 1. Docker Desktop ----------
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready

set "DOCKER_EXE=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
if not exist "%DOCKER_EXE%" set "DOCKER_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not exist "%DOCKER_EXE%" (
  echo [ERROR] Docker Desktop was not found. Install it or start it manually, then run start.bat again.
  goto fail
)

echo Docker is not running. Starting Docker Desktop, please wait
start "" "%DOCKER_EXE%"
call :wait_docker 120
if not errorlevel 1 goto docker_ready

rem After a crash or power loss Docker sometimes hangs; a full restart usually fixes it.
echo.
echo Docker did not start in 2 minutes. Restarting Docker Desktop once
taskkill /IM "Docker Desktop.exe" /F >nul 2>&1
taskkill /IM "com.docker.backend.exe" /F >nul 2>&1
wsl --shutdown >nul 2>&1
call :sleep 5
start "" "%DOCKER_EXE%"
call :wait_docker 180
if errorlevel 1 (
  echo.
  echo [ERROR] Docker is still not running. Open Docker Desktop, read its message, then run start.bat again.
  goto fail
)

:docker_ready
echo.
echo [OK] Docker is running.

rem ---------- 2. Database ----------
echo Starting database containers (postgres, redis)
docker compose up -d postgres redis
if errorlevel 1 (
  echo [ERROR] docker compose failed, see the message above.
  goto fail
)

set /a "_left=60"
:wait_pg
docker compose exec -T postgres pg_isready -U vitalo -d vitalo_dev >nul 2>&1
if not errorlevel 1 goto pg_ready
if %_left% LEQ 0 (
  echo [ERROR] PostgreSQL did not become ready in 60 seconds.
  goto fail
)
call :sleep 2
set /a "_left-=2"
goto wait_pg

:pg_ready
echo [OK] Database is ready.
echo.

rem ---------- 3. App windows ----------
call :start_app "VITALO API" "apps\api" "npm run start:dev" 3000
call :start_app "VITALO Mini App" "apps\miniapp" "npm run dev" 5173
if exist "%ROOT%apps\admin\package.json" call :start_app "VITALO Admin" "apps\admin" "npm run dev" 5174
rem Bot and tunnel have no port: "0" means "check only that the window is not open already".
call :start_app "VITALO Bot" "apps\bot" "npm run dev" 0

rem ---------- 3b. Public HTTPS tunnel for testing from a phone (optional) ----------
call :find_cloudflared
if defined CLOUDFLARED_FOUND (
  rem Addresses written after this moment are the fresh ones; 0 = tunnel already running, its addresses are current.
  set "TUNNEL_SINCE=0"
  call :window_running "VITALO Tunnel"
  if errorlevel 1 for /f %%T in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"') do set "TUNNEL_SINCE=%%T"
  call :start_app "VITALO Tunnel" "apps\bot" "npm run tunnel" 0
) else (
  echo [INFO] cloudflared is not installed, so there is no public address for the phone.
  echo        Install it once: winget install --id Cloudflare.cloudflared
  echo        then run start.bat again.
)

rem ---------- 4. Browser ----------
echo.
echo Waiting 15 seconds for the servers to start
call :sleep 15
start "" "http://localhost:5173"

rem ---------- 5. Wait for the public addresses and show them ----------
set "TUNNEL_FAILED="
set "ADMIN_FLAG="
if exist "%ROOT%apps\admin\package.json" set "ADMIN_FLAG=-WithAdmin"
if defined CLOUDFLARED_FOUND (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\wait-tunnel.ps1" -Since %TUNNEL_SINCE% %ADMIN_FLAG% -TimeoutSec 90
  if errorlevel 1 set "TUNNEL_FAILED=1"
)

echo.
echo === Ready ===
echo   Mini App : http://localhost:5173
echo   API docs : http://localhost:3000/api/docs
if exist "%ROOT%apps\admin\package.json" echo   Admin    : http://localhost:5174
echo   Bot      : https://t.me/vitalo_store_bot
if defined CLOUDFLARED_FOUND echo   Phone    : the public https addresses are shown above (and in the "VITALO Tunnel" window)
echo.
echo To stop everything, run stop.bat
if defined TUNNEL_FAILED goto fail
echo This window will close in 60 seconds.
call :sleep 60
endlocal
exit /b 0

:fail
echo.
pause
endlocal
exit /b 1


rem ============================================================
rem  Subroutines
rem ============================================================

rem :start_app "Window title" "folder" "command" port
rem Opens a separate classic console window (conhost), so stop.bat can close it
rem even when Windows Terminal is the default terminal. Installs packages on first run.
:start_app
call :window_running "%~1"
if not errorlevel 1 (
  echo [SKIP] %~1: its window is already open.
  exit /b 0
)
if not "%~4"=="0" (
  call :port_busy %~4
  if not errorlevel 1 (
    echo [SKIP] %~1: port %~4 is already in use, it seems to be running already.
    exit /b 0
  )
)
if not exist "%ROOT%%~2\package.json" (
  echo [SKIP] %~1: folder %~2 was not found.
  exit /b 0
)
echo Opening window: %~1
start "%~1" /D "%ROOT%%~2" conhost.exe cmd /k "title %~1 & (if not exist node_modules npm install) & %~3"
exit /b 0

rem :window_running "title"  -> errorlevel 0 if a window started by this script with that title is open
rem (two bot processes at once would fight over Telegram updates, so this matters for the bot)
:window_running
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*title %~1 &*' }) { exit 0 } else { exit 1 }" >nul 2>&1
exit /b %errorlevel%

rem :find_cloudflared  -> sets CLOUDFLARED_FOUND when cloudflared is installed
:find_cloudflared
set "CLOUDFLARED_FOUND="
where cloudflared >nul 2>&1 && set "CLOUDFLARED_FOUND=1"
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CLOUDFLARED_FOUND=1"
if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CLOUDFLARED_FOUND=1"
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set "CLOUDFLARED_FOUND=1"
exit /b 0

rem :port_busy port  -> errorlevel 0 if something listens on the port
:port_busy
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul
exit /b %errorlevel%

rem :wait_docker seconds  -> errorlevel 0 when the Docker engine answers
:wait_docker
set /a "_left=%~1"
:wait_docker_loop
docker info >nul 2>&1
if not errorlevel 1 exit /b 0
if %_left% LEQ 0 exit /b 1
<nul set /p "=."
call :sleep 3
set /a "_left-=3"
goto wait_docker_loop

rem :sleep seconds  (ping works even where "timeout" cannot read the keyboard)
:sleep
set /a "_n=%~1+1"
ping -n %_n% 127.0.0.1 >nul
exit /b 0
