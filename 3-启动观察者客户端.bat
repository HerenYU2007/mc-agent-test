@echo off
chcp 65001 >nul
setlocal
title Minecraft 1.21.11 观察者客户端
cd /d "%~dp0"
where gradle >nul 2>&1
if errorlevel 1 (
    echo [错误] 请先安装 JDK 21 和 Gradle 9.2.1，或用 Minecraft 启动器加载已构建的 Fabric Mod。
    pause
    exit /b 1
)
if not defined MC_CLIENT_SERVER set "MC_CLIENT_SERVER=127.0.0.1:25567"
if not defined MC_OBSERVER_DASHBOARD_PORT set "MC_OBSERVER_DASHBOARD_PORT=3001"
set "JDK_JAVA_OPTIONS=%JDK_JAVA_OPTIONS% -Dnmo.observer.port=%MC_OBSERVER_DASHBOARD_PORT%"
echo 正在连接 1.21.11 服务器 %MC_CLIENT_SERVER%
call gradle -p observer-mod runClient --args="--quickPlayMultiplayer %MC_CLIENT_SERVER% --username NMOViewer"
pause
