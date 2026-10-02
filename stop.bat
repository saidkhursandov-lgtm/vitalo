@echo off
setlocal
rem ============================================================
rem  VITALO - stop the local development environment started by start.bat:
rem  close the server windows, free ports 3000 / 5173 / 5174,
rem  stop the database containers (data is kept).
rem ============================================================
title VITALO stop
cd /d "%~dp0"

echo.
echo === VITALO: stopping local environment ===
echo.

rem ---------- 1. Close the windows opened by start.bat ----------
rem They were started as: cmd /k "title VITALO ... & ..." - find them by that command line.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*title VITALO *' } | ForEach-Object { Write-Host ('Closing window, process ' + $_.ProcessId); taskkill /PID $_.ProcessId /T /F | Out-Null }"

rem ---------- 2. Free the ports (servers started any other way) ----------
for %%P in (3000 5173 5174) do call :free_port %%P

rem ---------- 3. Stop the database ----------
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker is not running, nothing to stop there.
) else (
  echo Stopping database containers ^(postgres, redis^)
  docker compose stop postgres redis
)

echo.
echo Done. The data in the database is kept. Start again with start.bat
echo This window will close in 5 seconds.
ping -n 6 127.0.0.1 >nul
endlocal
exit /b 0


rem :free_port port  -> kills whatever process listens on the port
:free_port
for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do (
  if not "%%I"=="0" (
    taskkill /PID %%I /T /F >nul 2>&1 && echo Freed port %~1 ^(process %%I^)
  )
)
exit /b 0
