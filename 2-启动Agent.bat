@echo off
chcp 65001 >nul
title NMO-TestAgent (DeepSeek驱动)
cd /d "%~dp0"

echo ========================================================
echo   正在检查运行环境 (Node.js)...
echo ========================================================

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 系统中未找到 Node.js！请先安装 Node.js (推荐 v18 或 v20 及以上)。
    pause
    exit /b 1
)

echo [OK] 检测到 Node.js 运行时.

:: 检查并设置 DeepSeek API Key
if "%DEEPSEEK_API_KEY%"=="" (
    if exist ".env" (
        for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
            if "%%a"=="DEEPSEEK_API_KEY" set "DEEPSEEK_API_KEY=%%b"
        )
    )
)

if "%DEEPSEEK_API_KEY%"=="" (
    echo.
    echo --------------------------------------------------------
    echo 提示: 未检测到环境变量 DEEPSEEK_API_KEY。
    echo 如需开启 AI 模型大模型决策，请在下方粘贴输入；
    echo 若直接回车跳过，将以纯内建规则模式启动。
    echo --------------------------------------------------------
    set /p "DEEPSEEK_API_KEY=请输入 DeepSeek API Key: "
)

set "MC_VERSION=26.1"
set "MC_HOST=127.0.0.1"
set "MC_PORT=25567"
set "MC_USERNAME=NMO-TestAgent"
set "MC_VIEWER_PORT=3000"
set "MC_DASHBOARD_PORT=3001"
set "DEEPSEEK_MODEL=deepseek-flash"

echo.
echo ========================================================
echo   正在启动 Agent 智能体...
echo   目标服务器: %MC_HOST%:%MC_PORT%
echo   游戏版本  : %MC_VERSION%
echo   机器人名称: %MC_USERNAME%
echo   决策模型  : %DEEPSEEK_MODEL%
echo   网页控制台: http://127.0.0.1:%MC_DASHBOARD_PORT%
echo   网页视图器: http://127.0.0.1:%MC_VIEWER_PORT%
echo ========================================================
echo.

node agent.js
pause
