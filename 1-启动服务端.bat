@echo off
chcp 65001 >nul
title Minecraft 26.1 服务端 (端口 25567)
cd /d "%~dp0server261-fresh"

echo ========================================================
echo   正在检测 Java 运行时...
echo ========================================================

set "JAVA_BIN="
if exist "%APPDATA%\.minecraft\runtime\java-runtime-epsilon\bin\java.exe" (
    set "JAVA_BIN=%APPDATA%\.minecraft\runtime\java-runtime-epsilon\bin\java.exe"
    echo [OK] 找到 Minecraft 官方自带 Java: !JAVA_BIN!
) else if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" (
        set "JAVA_BIN=%JAVA_HOME%\bin\java.exe"
        echo [OK] 找到系统 JAVA_HOME: !JAVA_BIN!
    )
)

if "%JAVA_BIN%"=="" (
    where java >nul 2>&1
    if %errorlevel% equ 0 (
        set "JAVA_BIN=java"
        echo [OK] 使用 PATH 中的默认 java 命令
    ) else (
        echo [错误] 未检测到 Java 运行时！
        echo 请安装 Java 21+ 或 Java 25，或者安装官方 Minecraft 启动器。
        pause
        exit /b 1
    )
)

echo.
echo ========================================================
echo   正在启动 Minecraft 26.1 服务端 (server261-fresh)...
echo   服务端口: 25567
echo   输入 stop 并回车可正常保存地图并退出
echo ========================================================
echo.

"%JAVA_BIN%" -Xms1G -Xmx2G -jar server.jar nogui
pause
