@echo off
chcp 65001 >nul
setlocal
title Minecraft 1.21.11 Agent
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 请先安装 Node.js 24。
    pause
    exit /b 1
)
echo 正在启动 Agent。默认监控地址 http://127.0.0.1:3001/
echo DeepSeek 可通过本地 .env 或用户环境变量配置。
node --env-file-if-exists=.env agent.js
pause
