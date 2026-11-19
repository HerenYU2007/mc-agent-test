@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-sync.ps1" %*
if errorlevel 1 (
  pause
  exit /b 1
)
