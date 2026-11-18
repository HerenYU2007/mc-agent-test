@echo off
chcp 65001 >nul
title Minecraft 26.1 观察者客户端 (NMOViewer)
cd /d "%~dp0"

echo ========================================================
echo   正在启动 Minecraft 26.1 旁观者客户端窗口...
echo   目标服务器: 127.0.0.1:25567
echo   角色身份  : NMOViewer (旁观者视角)
echo ========================================================
echo.

set "MC_CLIENT_SERVER=127.0.0.1:25567"
node launch-client261-vanilla.js
pause
