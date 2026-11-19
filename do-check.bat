@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Local checks; detailed scope and examples are in docs/testing.md.
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 24 or later, then try again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo The dependencies are not installed. Run "npm install" in this folder first.
  pause
  exit /b 1
)
if /i "%~1"=="full" (
  if not "%~2"=="" (
    echo Full checks take no additional arguments. Use "list" to preview targeted checks.
    exit /b 1
  )
  call npm run check
) else (
  node scripts/check.mjs %*
)
if errorlevel 1 (
  pause
  exit /b 1
)
endlocal
