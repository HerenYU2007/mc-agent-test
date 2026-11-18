@echo off
chcp 65001 >nul
title 安装与修复项目依赖 (NMO Agent)
cd /d "%~dp0"

echo ========================================================
echo   正在检查 Node.js 与 npm 环境...
echo ========================================================

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 系统中未找到 Node.js！请先安装 Node.js (推荐 v18 或 v20 及以上)。
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 系统中未找到 npm！
    pause
    exit /b 1
)

echo [OK] 检测到 Node.js 与 npm 环境.
echo.

if not exist "node_modules" (
    echo [1/3] 正在安装 npm 依赖包 (可能需要 1~3 分钟，请稍候)...
    call npm install --no-audit
    if %errorlevel% neq 0 (
        echo [警告] npm install 存在警告或错误，将继续尝试应用补丁。
    )
) else (
    echo [1/3] 检测到已存在 node_modules 目录，跳过全局 npm install。
)

echo.
echo [2/3] 正在应用针对 Minecraft 26.1 / 26.3 的版本兼容补丁...
if exist "patch-mcdata.js" (
    node patch-mcdata.js
)
if exist "patch-viewer-bundle.js" (
    node patch-viewer-bundle.js
)
if exist "patch-mineflayer-263.js" (
    node patch-mineflayer-263.js
)

echo.
echo [3/3] 正在执行 agent.js 语法完整性验证...
node --check agent.js
if %errorlevel% equ 0 (
    echo [成功] agent.js 语法检查通过！项目依赖与补丁全部就绪。
) else (
    echo [错误] agent.js 语法检查未通过，请检查报错。
)

echo.
echo ========================================================
echo   依赖安装与补丁应用完成！
echo ========================================================
pause
