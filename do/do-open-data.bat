@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Opens fat-g's data folders in Explorer: %APPDATA%\fat-g (packaged and installed) and
rem %APPDATA%\fat-g-dev (development runs). A folder that no run has made yet is skipped (see do-readme.md).
setlocal

if exist "%APPDATA%\fat-g" (start "" "%APPDATA%\fat-g") else (echo %APPDATA%\fat-g does not exist yet: no packaged or installed fat-g has run.)
if exist "%APPDATA%\fat-g-dev" (start "" "%APPDATA%\fat-g-dev") else (echo %APPDATA%\fat-g-dev does not exist yet: no development build has run.)
endlocal
