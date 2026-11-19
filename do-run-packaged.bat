@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Starts the packaged app already built in release\release\win-unpacked\, without building it again:
rem for a second launch of the same build. Build it first with do-package.bat or do-package-and-run.bat.
rem Its data lives in %APPDATA%\fat-g (see do-readme.md).
setlocal
cd /d "%~dp0"

if not exist "release\release\win-unpacked\fat-g.exe" (
  echo The packaged app is not built. Run do-package-and-run.bat first.
  pause
  exit /b 1
)

start "" "%~dp0release\release\win-unpacked\fat-g.exe" %*
endlocal
