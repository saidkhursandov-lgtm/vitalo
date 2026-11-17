#!/usr/bin/env bash
# One-time link of the nightly backup to the owner's Google Drive (17.11.2026). Run on the server as `vitalo`:
#   /opt/vitalo/app/scripts/server/gdrive-setup.sh
# Before that, on the laptop (PowerShell):  rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ=="
# -> the browser opens, sign in to Google, allow; PowerShell prints a code in braces {"access_token":...}.
# This script asks to paste that code (input is hidden), saves it only in ~/.config/rclone/rclone.conf (rights 600)
# and checks the folder VITALO-backups. Access is "drive.file": rclone sees only the files it created itself.
set -euo pipefail
[ "$(id -un)" = "vitalo" ] || { echo "Запустите от пользователя vitalo: ssh vitalo@<сервер>" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone не установлен (sudo apt install rclone)" >&2; exit 1; }

while :; do
  read -rsp "Вставьте код из PowerShell (всё от { до }) и нажмите Enter: " T; echo
  T="$(printf '%s' "$T" | tr -d '\r\n')"
  case "$T" in \{*access_token*\}) break ;; esac
  [ -n "$T" ] && echo "Не похоже на код (нужно всё от { до }). Скопируйте ещё раз."
done

rclone config delete gdrive >/dev/null 2>&1 || true
rclone config create gdrive drive scope=drive.file token="$T" config_is_local=false >/dev/null
unset T
chmod 600 "$(rclone config file | tail -1)"
rclone mkdir gdrive:VITALO-backups
rclone lsd gdrive: | grep -q VITALO-backups && echo "ГОТОВО: Google Drive подключён, папка VITALO-backups есть."
