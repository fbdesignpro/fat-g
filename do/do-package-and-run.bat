@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Builds the release package's unpacked app (npm run package:dir, faster than do-package.bat: no
rem installer) and starts it from release\release\win-unpacked\. Nothing is installed. Its data lives
rem in %APPDATA%\fat-g, the folder an installed fat-g uses too (see do-readme.md).
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

call npm run package:dir
if errorlevel 1 (
  pause
  exit /b 1
)

start "" "%~dp0..\release\release\win-unpacked\fat-g.exe" %*
endlocal
