@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Builds the release package (npm run package): the unsigned installer and the unpacked app, both
rem in release\release\, or release\NAME\ with --output NAME. Starts and installs nothing.
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

call npm run package -- %*
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Built the installer and unpacked app into the folder printed above.
endlocal
