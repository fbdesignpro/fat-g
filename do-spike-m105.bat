@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Research only: M105's bounded installed-CLI status-lifecycle spike.
rem No prompt is sent without --confirm-turns 1. See spikes/README.md.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 or later, then try again.
  exit /b 1
)
node spikes/m105/k1.mjs --record-file spikes/output/m105/launched.json %*
exit /b %errorlevel%
