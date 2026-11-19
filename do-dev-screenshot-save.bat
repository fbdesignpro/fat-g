@echo off
rem SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
rem SPDX-License-Identifier: MIT

rem Double-click after closing the window you want to save; choose its source in the dialog.
call "%~dp0do-dev-setup.bat" save
if errorlevel 1 exit /b %errorlevel%
echo.
pause
