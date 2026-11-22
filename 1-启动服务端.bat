@echo off
chcp 65001 >nul
setlocal
title Minecraft 1.21.11 本地测试服
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\start-test-server.ps1"
pause
