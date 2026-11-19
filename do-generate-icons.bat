@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
node scripts/generate-app-icons.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
endlocal
