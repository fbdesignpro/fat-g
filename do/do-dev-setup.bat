@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Freeze and replay named development setups. See docs/dev-setups.md.
setlocal
cd /d "%~dp0.."
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
node scripts/dev-setup.mjs %*
set "setupResult=%errorlevel%"
if not "%setupResult%"=="0" pause
if "%~1"=="" pause
exit /b %setupResult%
