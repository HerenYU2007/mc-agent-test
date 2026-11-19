@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-sync.ps1" -Action Stop
set "SYNC_EXIT=%ERRORLEVEL%"
pause
exit /b %SYNC_EXIT%
