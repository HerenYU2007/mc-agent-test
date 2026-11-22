@echo off
chcp 65001 >nul
setlocal
title 安装 Minecraft 1.21.11 Agent 依赖
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
    echo [错误] 请先安装带 npm 的 Node.js 24。
    pause
    exit /b 1
)
call npm ci --no-audit
if errorlevel 1 (
    echo [错误] 依赖安装失败。
    pause
    exit /b 1
)
call npm run test:syntax
if errorlevel 1 (
    pause
    exit /b 1
)
echo 依赖安装和语法检查完成。
pause
