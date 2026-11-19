@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Records the stored formats' baselines this build has none of, into tests\fixtures\baselines\ (decision 0014).
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
if not "%~1"=="" (
  echo Recording takes no arguments: it writes each missing baseline into tests\fixtures\baselines\ and replaces none.
  exit /b 1
)
set "FATG_RECORD_BASELINES=1"
call npx vitest run tests/baselines/record.test.ts --project node
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo The baselines in tests\fixtures\baselines\:
dir /b tests\fixtures\baselines
echo.
echo Review a new file, then run: do-check.bat focused --area baselines
endlocal
