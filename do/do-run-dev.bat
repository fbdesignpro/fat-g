@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Starts the fat-g development build (npm run dev) from the repository folder, wherever it is launched from.
rem Its data lives in %APPDATA%\fat-g-dev, separate from that of a packaged or installed fat-g (see do-readme.md).
setlocal
cd /d "%~dp0.."

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
  echo The dependencies are not installed. Run "npm install" in the repository folder first.
  pause
  exit /b 1
)

call npm run dev -- -- %*
if errorlevel 1 pause
endlocal
