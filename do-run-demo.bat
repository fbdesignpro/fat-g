@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Starts the fat-g development build with the demo source on (docs/planning/_archive/M14.md, Design 5):
rem it drives the sessions that exist through its script, so the list shows every capsule state.
rem It starts no CLI session and spends no turn. Data lives in %APPDATA%\fat-g-dev, as with do-run-dev.bat
rem (see do-readme.md).
rem
rem   do-run-demo.bat         drives the sessions the dev records already hold (FATG_DEMO_SESSIONS=1)
rem   do-run-demo.bat seed    also adds three sessions to each project that has none (=seed)
setlocal
cd /d "%~dp0"

rem npm is not always on PATH (a shell opened before Node was installed, for one): try the default install.
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

set "FATG_DEMO_SESSIONS=1"
if /i "%~1"=="seed" set "FATG_DEMO_SESSIONS=seed"

call npm run dev
if errorlevel 1 pause
endlocal
